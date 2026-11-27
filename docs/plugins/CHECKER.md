# Library check plugin

`plugins/checker`: a JS page plus a native part (`plugins/checker/native`, crate `bootleg-plugin-checker`, Cargo feature `plugin-checker`), plugin spec 2.0. Its own version and [CHANGELOG](../../plugins/checker/CHANGELOG.md). Desktop only. It is experimental on every desktop OS until it has been run on real libraries there.

It is the "checking rips already in the library" part of the [CD design](CD.md#checking-rips-already-in-the-library), widened to every file in the library.

## Using it
Turn it on in *Settings → Plugins*. Then, on the **Library check** page, choose the whole library or one folder and press *Check*. Every file is read all the way through, up to four at once. Files already checked and unchanged since (same size and modification time, same version of the checks) are not read again unless *Read every file again* is on. Results are kept in the app's cache folder (`plugins/checker/results.json`).

What it finds goes onto each track, so it shows everywhere and survives the page:
- **tags:** `check:damaged`, `check:truncated`, `check:changed`, `check:lossy-source`, `check:upsampled`, `check:padded-bits`, `check:clipping`, and from AccurateRip `rip:verified` / `rip:suspect`. A re-check removes the `check:` tags that no longer apply. `rip:` tags are only changed when the album was actually checked against AccurateRip.
- **a note** written by the plugin, starting "Library check:", replaced on every re-check and removed when nothing is left to say. Your own notes are never touched.
- **defects** for damage with a known time (`unreadable`, and `missing` for the end of a file cut short): ⚠ in the lists, red bands on the timeline, `has:defects`.

The page groups the findings, with play buttons. The Notes view filters by tag.

## The checks
| Check | How | Tag |
|---|---|---|
| Damage | FLAC: claxon checks every frame's CRC; decoding stops at the first broken frame (everything after it is marked; `flac -F` can often recover more). Others: symphonia skips damaged packets and carries on, and each damaged stretch is located. | `check:damaged` |
| Cut short | The decoded length against the length the header promises. | `check:truncated` |
| Audio changed | FLAC only: the MD5 of the decoded audio against the one the encoder stored. With no damage, a mismatch means the audio was altered after encoding. | `check:changed` |
| Made from a lossy file | A lossless file whose spectrum stops at a cliff below 20 kHz (a lossy encoder's lowpass), with a bitrate guess (≈16.7 kHz for a 128 kbps MP3). A gentle fade at the same frequency is not flagged. Some old masters were filtered like this, so the note says so. | `check:lossy-source` |
| Upsampled | An 88.2 kHz or higher file with a cliff at or below 24.5 kHz. | `check:upsampled` |
| Padded bit depth | A 20-bit or higher file whose samples only use the top 16 bits. | `check:padded-bits` |
| Clipping | Runs of 3 or more identical samples at the file's peak, when that peak is within 1 dB of full scale. Flagged at 20 runs, or one per 10 seconds, whichever is more. | `check:clipping` |
| Dynamic range | DR by the TT DR meter method (3 s blocks, loudest 20%, second-highest peak). Shown on the page, not tagged. | |
| AccurateRip | See below. | `rip:verified` / `rip:suspect` |

The spectrum is averaged over up to 160 windows of 4096 samples spread across the file, leaving out silent ones. The cutoff is where the level falls furthest compared with everything above it, placed where it first drops 10 dB below the plateau leading up to it. The thresholds (what counts as a cliff, the bitrate guesses, the clipping limit) are in `checker-logic.js`, so they can be tuned in a plugin update without touching the native part.

## AccurateRip without the disc
As CUETools does it: the tracks of an album (grouped by folder, album and disc number, ordered by track number, and only when the numbers run 1…n with no gap) give the disc's table of contents. A track's length in CD sectors is its length on the disc, so the TOC gives the AccurateRip and MusicBrainz ids. Each track's AccurateRip v1 and v2 sums are worked out while it is decoded, for every first/last-track case, so no file is read twice.

This works when the rip kept the disc's layout: one file per track, 16-bit stereo 44.1 kHz lossless, gaps appended to the previous track (the usual default), no hidden track before track 1, and no data track. Otherwise the album is reported as "not a CD layout" or "not found", which is not a failure.

## Not yet
- Rip logs (EAC, XLD, whipper …) as provenance, and their suspicious positions as `uncertain` defects.
- `.cue` sheets (for pregaps, hidden tracks and image + cue rips), and Enhanced CDs.
- AccurateRip matches at a different read offset (a rip with the wrong drive offset is still a good rip).
- CTDB verification and repair.
- Glitch detection (skips, clicks, dropouts in the middle of music).
- Opus files (symphonia has no Opus decoder).
- A search syntax for tags in the track list (today: the Notes view).

## Testing
- `cargo test --manifest-path plugins/checker/native/Cargo.toml` runs the checks on generated files:
  - a clean FLAC, a damaged one and a truncated one
  - a synthetic lowpass cliff and a natural fade
  - AccurateRip on a 3-track album, against a mocked database with a matching and a mismatching entry
  - checking that the cache means nothing is read the second time
  - where ffmpeg is installed: a 128 kbps MP3 saved as FLAC, a 96 kHz upsample, 16-bit audio in a 24-bit FLAC, and a damaged MP3
- `node plugins/checker/checker.test.mjs` covers the findings, the wording, album grouping and the annotations.
- The desktop self-test runs a real check over the self-test library, including the CD plugin's ripped album, with AccurateRip offline.
