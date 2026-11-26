# CD plugin: play, rip, tag

Status: **0.1 implemented, `experimental` on macOS** (2026-11-26). It has not run against a real drive yet; see *Trying it* below. Built on [plugin spec 2.0](../PLUGIN-SPEC.md).

**What 0.1 does:**
- the Rip page: drive, disc, MusicBrainz release picker and cover, editable tags, output and reading options
- secure reading: two passes with the cache defeated, re-read rounds that slow the drive down, C2 when you trust it
- the read offset, from AccurateRip's drive list
- AccurateRip v1/v2 verification
- output: FLAC (decoded back and compared before it's kept), WAV or AIFF, with tags, cover, cue sheet, playlist, and the log in text and JSON
- salvage of damaged discs, with defects in the library
- import with `cd-rip` provenance and `rip:*` tags

**Not yet:**
- playing a disc without ripping it (the source kind)
- CTDB verification and repair
- the library checker
- pregap/HTOA detection from the Q subchannel
- remembering raw reads for later re-rips
- the Linux and Windows backends

The code lives in `plugins/cd/`: `index.js` is the page, `cd-logic.js` its logic, and `native/` the Rust part (`toc`, `backend/{sim,macos}`, `secure`, `salvage`, `accuraterip`, `output`, `rip`, `plugin`).

## Trying it
**Without a drive:**
1. Run `node scripts/make-cd-sim.mjs /tmp/cdsim`.
2. Start bootleg with `BOOTLEG_CD_BACKEND=sim BOOTLEG_CD_SIM=/tmp/cdsim`, then turn on the plugin in Settings → Plugins.
3. Two simulated drives appear. *Clean* rips secure. *Damaged* has a light scratch that recovers, 10 dead sectors that are salvaged and flagged, and sectors that only read slowly.

To try the engine alone: `cargo run --example rip_sim -- /tmp/cdsim sim:Damaged /tmp/out` in `plugins/cd/native`.

**With a drive (the milestone 1 spike):**
1. Connect the drive, insert an audio CD, open the CD page and press **Check drive**.
2. It reports whether these work while macOS keeps the disc mounted: the TOC, audio reads, C2 and Q subchannel in one read, the offset units, the Q position and CRC, speed control, ISRC and MCN.
3. Add the result to the hardware log below. Then rip a disc that is in AccurateRip with the offset looked up. Every track coming back *Accurate* confirms the whole path.

**Goal:** a ripper as careful as the rest of bootleg: secure and verified, and able to recover discs that iTunes and other quick rippers give up on. When a disc is too damaged for a perfect copy, it saves as much of the audio as can be read, and the library shows exactly what is missing or uncertain.

| Target | Status | Backend |
|---|---|---|
| macOS 12+ | `experimental` until the hardware log has an entry | `macos-iokit`: `DKIOCCDREAD` on `/dev/rdiskN` (user data + C2 error flags + Q subchannel), `DKIOCCDREADTOC` / `ISRC` / `MCN`, `DKIOCCDSETSPEED`; DiskArbitration for insert/eject |
| Linux | `unavailable` (not written yet; then `experimental`) | `linux-sgio`: SG_IO with MMC `READ CD` (0xBE), `READ TOC/PMA/ATIP`, `SET CD SPEED` |
| Windows | `unavailable` (not written yet; then `experimental`) | `windows-spti`: `IOCTL_SCSI_PASS_THROUGH_DIRECT` with the same MMC commands |
| web | `unavailable` | browsers cannot read drives |

## Provides
- **source**: an inserted disc appears as a transient library connection (title from the lookup, otherwise "Audio CD"). It plays straight from the drive through a `Media` stream that does offset-corrected reads. Notes, ratings and listening history are keyed `cd:<MusicBrainz disc id>/<track>`, so they come back when the disc is inserted again, and they carry over to the files when the disc is ripped.
- **metadata**: disc lookup from the TOC: MusicBrainz (disc id, release, ISRCs), then gnudb (CDDB), then the CD-Text on the disc. Covers come from the Cover Art Archive. When several releases match (different pressings or countries), the user picks one from a list.
- **view**: the *Rip* page: drive and disc, release picker, editable tags, output settings, then a live per-track sector map while ripping, the results, and the log.

## Secure reading engine
All of this sits above the backend trait, so it runs and is tested identically on every OS against `sim`:
1. **Drive profile** (stored per drive model and firmware):
   - Read offset: taken from the AccurateRip drive database, or measured from a disc already in AccurateRip.
   - Whether the drive caches audio, and how much.
   - Whether its C2 error pointers can be trusted.
   - Whether it can overread into the lead-in and lead-out.

   The profile is measured once, the first time a drive is used, and can be re-measured.
2. **Disc layout:**
   - Pregaps and indexes, from the Q subchannel
   - HTOA (hidden track one audio)
   - Pre-emphasis flags
   - ISRCs and MCN
   - Data tracks (Enhanced CD)
3. **Secure reading:** every sector is read at least twice, with the drive's cache defeated between reads. A sector is accepted only when the reads match and no C2 errors are flagged (C2 is used only if the profile trusts it). Sectors that don't pass are re-read up to N times. Each sector's final value is the consensus of those reads, and how much the reads agreed becomes its confidence.
4. **Escalation for bad sectors:**
   - lower the read speed
   - approach the sector from different directions and distances (seek patterns)
   - ask the drive to re-read with ECC/C2 handling switched (on drives that support it)
   - longer timeouts
   - and finally, more passes
5. **Verification:** AccurateRip v1 and v2, and the CUETools database (CTDB). The FLAC files are decoded after encoding and compared against the ripped audio.
6. **Repair:** if a track fails verification and the disc is in CTDB, its recovery data can repair a limited number of damaged samples. This is the main way to get a verified rip of a disc that other rippers fail on.

## Damaged discs: get as much as possible, show what is missing
Damage that can't be fixed doesn't stop the rip. Instead:
- **Every rip records a damage map** for each sector: read OK, uncertain (the reads disagree), or unreadable, plus how many passes it took. The map and all the raw reads are kept in the plugin's cache. Because of that, a **resumed or later re-rip only re-reads the bad sectors**: after cleaning the disc, in another drive, or on another day. Each new read is combined with the earlier ones, and the result keeps getting better.
- **Repair is tried first.** CTDB repair is attempted before anything is marked as missing.
- **What fills a gap is a setting:**

  | Gap type | Default | Other choices |
  |---|---|---|
  | Uncertain sectors | Keep the best consensus samples | Silence, interpolation |
  | Unreadable sectors, short | Interpolate (conceal clicks) | Silence, best guess |
  | Unreadable sectors, long | Silence | Interpolation, best guess |

  The cutoff between short and long can be changed. All choices are written to the log.
- **Flagged in the library:** every unreadable, uncertain or interpolated stretch becomes a `defect` on the track (spec §6). The track and its album get a ⚠ badge, the damaged stretches show as red bands on the Now playing timeline and the seek bar, and `has:defects` / *Damaged* lists them. Provenance records "CD rip, damaged: 3 of 12 tracks not verified".
- **Fixing it later:** if a later re-rip or repair verifies a track, its defects are cleared and its file is replaced. If the user replaces a track from another source (another copy of the CD, a download), they can mark it as such: the defects are cleared and provenance notes where the replacement came from.

## Checking rips already in the library
The checker works on files without a drive. Run it on an album, a selection or the whole library (in the background, as an incremental job). What it finds goes into the existing annotations:
- tags: `rip:verified`, `rip:suspect`, `rip:damaged`, `rip:fake-lossless`, `rip:truncated`
- a note explaining each finding
- defects for any stretch that has a known time
- provenance updated from the rip log

Checks:
1. **Rip logs next to the files** (EAC, XLD, whipper, dBpoweramp, CUERipper):
   - Imported as provenance (ripper, drive, offset, AccurateRip result).
   - EAC's "suspicious position" timestamps become `uncertain` defects.
   - Track CRC mismatches between the two passes ("Copy CRC mismatch"), and a log checksum that doesn't validate, are noted.
2. **AccurateRip / CTDB verification of existing files:** the CD's table of contents comes from the `.cue` or log if there is one, otherwise from the MusicBrainz disc ids of the tagged release (or of the release the track lengths match). Then the CRCs are computed from the decoded audio. A match means `rip:verified`. A mismatch means `rip:suspect` (or `rip:damaged` if CTDB can locate the bad samples).
3. **File integrity:** the FLAC MD5 signature is checked against the decoded audio, frames that fail to decode are found (FLAC, MP3, AAC, Ogg), and the length is compared with the release on MusicBrainz to catch a truncated file.
4. **Glitches in the audio:** heuristic, and reported with lower confidence. It looks for:
   - runs of exact digital silence or repeated samples in the middle of music
   - repeated blocks a multiple of a CD frame long (the "skip" a bad read leaves)
   - isolated spikes (clicks)
5. **Fake lossless:** a "lossless" file with a lossy encoder's frequency cutoff or holes in its spectrum. This reuses the spectrogram bootleg already draws for the timeline.

Decoding uses `symphonia` (MPL-2.0, so it can be linked).

## Fixing bad rips
Fixes are tried in this order, from fully restoring the original to only covering up the damage:
1. **CTDB repair:** from the parity data the CUETools database keeps. It works on rips already in the library as well as on new ones, and gives a bit-exact original when the damage is within its limits.
2. **Re-rip only the bad parts**, if you still have the disc. The checker maps each defect to sectors, so the ripper re-reads only those sectors and splices them in. Physically resurfacing the disc first (a buffing machine, which many used-media shops have) is worth suggesting for a deeply scratched disc.
3. **Patch from another copy** (another pressing, a second CD, a download): the other copy is aligned to the sample with cross-correlation, and only the damaged stretches are spliced in. The patch is checked against AccurateRip/CTDB afterwards. If the other copy is lossy, the patched stretches stay flagged as defects of kind `interpolated`, with a note saying where the patch came from.
4. **Concealment:** short gaps are filled with interpolation from the surrounding audio (an autoregressive model, the standard method for this). The result is flagged, not called fixed.
5. **Hand-off for manual restoration:** "Open at this defect" in iZotope RX or Audacity, at the defect's timestamp. When the file comes back, its defects stay until a check passes.

Outside tools:
- **CUETools/CUERipper** (Windows, .NET) is the reference for CTDB repair. It is GPL, so its code can't be linked or ported into bootleg. Before writing our own repair, the CTDB parity format needs a clean-room description and a license check.
- **flac** (`-F` decodes through errors) and **mp3val** are worth calling as optional external tools if they're installed. They're good at salvaging and rebuilding broken files.
- **XLD, EAC, whipper and dBpoweramp:** their logs are imported, as in check 1 above.

## Output
- **Format:** FLAC by default. Also WAV, AIFF, ALAC and WavPack, plus an optional lossy copy (Opus or MP3) alongside the lossless one.
- **Layout:** one file per track by default, or a single file with a cue sheet. The folder/file naming pattern can be changed (a `template` setting with a preview).
- **Written next to the audio:**
  - `.cue`, including pregaps, ISRCs and the CD-Text
  - a log in plain text and JSON, covering the drive, its offset, each track's CRCs, the AccurateRip and CTDB results, and the damage map
  - `cover.jpg`
  - an M3U8 playlist
- **Tags (written with lofty):** the usual fields plus the MusicBrainz ids, ISRC, barcode/catalogue number, ReplayGain, and the AccurateRip and CTDB results.
- **Added to the library at once** (`api.library.import`), with provenance filled in: "retail CD rip, <date>, <drive>, AccurateRip verified / repaired / damaged".

## Licensing
No GPL code is used. The reader, the cache-defeating logic and the verification code are written for this plugin, using the MMC spec and the published AccurateRip and CTDB algorithms as references. FLAC encoding uses `flacenc` (pure Rust, MIT/Apache) and tags use `lofty`. The plugin reads discs as Red Book audio and does nothing to get around copy-protection schemes.

## Testing
- **Simulator backend (`sim`):** reads BIN/CUE images (and CloneCD `.img/.sub` for subchannel data). Fault profiles inject the kinds of damage real discs have: random and burst errors (scratches), C2 flags that are right or wrong, read jitter, drive caching, sectors that only read sometimes, and sectors that never read. Fixture discs check every engine path, including that salvage produces the expected damage map and defects. Runs in CI on macOS, Linux and Windows.
- **Linux and Windows VMs:** a mounted ISO can't be used for this test. ISO images only hold data sectors (2048 bytes each) and can't contain audio tracks. The VMs run the `sim` backend, the build and drive detection instead. For real Linux and Windows hardware tests before you have those machines, **pass a USB optical drive through to the VM** (UTM and Parallels both support USB passthrough). That exercises the real `linux-sgio` / `windows-spti` code paths.
- **Hardware log** (spec §7):

  | Drive | OS | Backend | Date | Result |
  |---|---|---|---|---|
  | — | | | | |

## Milestones
1. **Spike (macOS):** confirm that `DKIOCCDREAD` returns C2 flags and Q subchannel on the test drive while macOS has the disc mounted. Read the TOC and compute the MusicBrainz disc id. *This decides the macOS backend, so it comes first.*
2. Implement the spec 2.0 core: manifest, `api.native`, `Jobs`, `Media`, `api.sources.attach`, `api.metadata` and defects.
3. Play a disc as a transient source; lookup and release picker.
4. Secure rip to FLAC with offset correction, AccurateRip/CTDB verification, tags, log and cue, then import to the library.
5. Salvage: the damage map, resume/re-rip of bad sectors only, gap filling, defects in the library.
6. CTDB repair, drive profiling and the escalation strategies.
6a. Library checker: logs, AccurateRip/CTDB on files, integrity, glitches, fake lossless. Needs no drive; can come earlier, right after milestone 2.
6b. Fixing: re-rip only the bad sectors, patch from another copy, concealment, hand-off to RX/Audacity.
7. Linux and Windows backends, tested through USB passthrough.

## Open questions
- Merging reads from two drives in one session (beyond resuming a rip later in another drive): needed for 1.0?
- Should the per-sector cache of raw reads be kept after a damaged rip finishes, to allow a later re-rip? It is roughly 700 MB per disc. Proposal: keep it until every track verifies or the user discards it.
