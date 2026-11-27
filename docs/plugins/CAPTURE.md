# Record plugin (vinyl and tape)

`plugins/capture`: a JS page plus a native part (`plugins/capture/native`, crate `bootleg-plugin-capture`, Cargo feature `plugin-capture`), plugin spec 2.0. Its own version and [CHANGELOG](../../plugins/capture/CHANGELOG.md). Desktop only. It is experimental until it has been used with real decks and interfaces (hardware log below).

## Using it
Turn it on in *Settings → Plugins*. On the **Record** page:
1. **Set up:** choose what you are recording from (vinyl, tape, other), your turntable or deck (free text, for the provenance), the input, the sample rate (the input's own, or any rate it supports; 96 kHz is a good choice for vinyl) and a name.
2. **Record:** press *● Record*, play the side through, press *Finish side*.
   - The meters show peak and RMS per channel, and the number of clipped samples. Set the level so the loudest parts peak around −6 dB.
   - *Throw away* deletes the recording.
   - The recording is a 32-bit float WAV in the app's data folder, so nothing is rounded or clipped before saving. It is kept until you delete it: *Recordings kept* lists them, so a side can be saved again or after a restart.
3. **Tracks:**
   - The waveform shows the side, with the suggested tracks.
   - Click the waveform to add a split. In the track list, ◂ ▸ move a split by half a second and ⨯ joins two tracks.
   - Fill in the album, album artist, year and genre, and the first track number (side B usually continues from side A).
4. **Titles:** type them, or press *Find the titles online…*. That asks the metadata providers (MusicBrainz) using the album and artist you typed and the side's track lengths. *Use these titles* matches the side to the release by length, so side B picks up from the right track.
5. **Save:**
   - Choose click removal on or off, 24-bit FLAC (default) or 16-bit (dithered), and the folder (a library folder by default).
   - The tracks are tagged, named `{albumartist}/{album}/{track} {title}`, and imported into the library with provenance (`vinyl-rip` / `tape-transfer`, the date, deck → input, and how many clicks were removed) and the same tag.
   - The raw recording can then be deleted.

macOS asks for permission to use the input the first time (the app's `Info.plist` says why).

## How it works
- **Input** (`backend/`): one contract, with two backends.
  - `system` uses `cpal` (Apache-2.0): CoreAudio on macOS, WASAPI on Windows, ALSA on Linux. It turns any sample format into f32, and prefers stereo and float formats.
  - `sim` plays WAV files from a folder as if they were inputs (`BOOTLEG_CAPTURE_BACKEND=sim`, `BOOTLEG_CAPTURE_SIM=<folder>`, `BOOTLEG_CAPTURE_SIM_SPEED=<×>`).
- **Finding the tracks** (`analyze.rs`):
  - Loudness is measured every 50 ms, then judged by the median of five windows, so a click in a gap doesn't break it.
  - The surface noise is the quietest 1%, the music the median. Quiet means below 30% of the way from the noise to the music (at least 12 dB under the music).
  - Every quiet stretch of 1 s or more inside the music gets a split in its middle. The lead-in and run-out are left off, and tracks shorter than 20 s are joined to their shorter neighbour.
- **Clicks** (`declick.rs`):
  - A click is a burst of at most 2 ms where the sample-to-sample change jumps 12 times above the local average (and above an absolute floor). The level must also settle back to where the slope before it was heading.
  - It is redrawn with a cubic curve through the samples on either side.
  - Music's own attacks last longer and don't settle back, so they are left alone: the tests check drum-like noise bursts.
- **Saving** (`save.rs`): each track is read from the WAV on its own (a long side never has to fit in memory), declicked, given a 5 ms fade at each cut, quantized (TPDF dither at 16 bits), encoded with `flacenc`, tagged with `lofty`, and moved into place.

## Not yet
- Removing crackle and hum, and fixing speed (for tapes).
- RIAA EQ for phono inputs without a preamp. (Use a phono preamp, or a USB turntable that has one.)
- Recording both sides into one session, and auto-stop at the run-out groove.
- Editing a track's start or end beyond the splits, such as trimming a fade-out.
- Recordings over 4 GB (the WAV limit: about 3 hours of 96 kHz stereo).

## Testing
- `cargo test --manifest-path plugins/capture/native/Cargo.toml`:
  - clicks found and repaired (at least 90% of injected clicks, repaired to within 0.08 of the original), with none found in clean music or on drum hits
  - splits on a constructed side
  - a whole side recorded from the simulated turntable, split and saved, with tags and 24-bit FLAC checked; and a cancelled recording deleted
- `cargo test … -- --ignored list_system_inputs` lists the real inputs. It opens nothing.
- `node plugins/capture/capture.test.mjs` covers splits, numbering, titles from a release (side B), provenance, and the page's flow with a mocked native side.
- The desktop self-test records a simulated side in the real app, saves it, imports it and deletes the raw recording.

## Hardware log
| Date | Deck / source | Interface | OS | Result |
|---|---|---|---|---|
| | | | | |
