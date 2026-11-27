# Changelog: Library check plugin

All notable changes to this plugin. It is versioned on its own, apart from the app ([docs/UPDATES.md](../../docs/UPDATES.md)). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-26
### Added
- Decodes every file all the way through: damaged stretches located, files cut short, FLAC frame checksums and the stored MD5 of the audio.
- Lossy files saved as lossless (a lowpass cliff, with a bitrate guess), upsampled hi-res files, 16-bit audio in 24-bit files.
- Clipping (flattened runs at full scale) and dynamic range (DR, TT meter method).
- AccurateRip for CD rips already in the library, without the disc, from the album's track lengths.
- Findings go onto tracks as `check:…` / `rip:verified` / `rip:suspect` tags, a note, and defects for damage; a re-check takes back what no longer applies.
- Results are cached, so a re-check only reads files that changed. Up to four files are read at once.
