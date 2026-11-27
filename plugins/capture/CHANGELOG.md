# Changelog: Record plugin

All notable changes to this plugin. It is versioned on its own, apart from the app ([docs/UPDATES.md](../../docs/UPDATES.md)). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-26
### Added
- Recording from any audio input (CoreAudio, WASAPI, ALSA) at the rates it supports, into a 32-bit float WAV, with level meters and clipping warnings.
- Tracks suggested at the quiet gaps (judged against the surface noise, not fooled by clicks in the gaps); splits added on the waveform, nudged, or removed.
- Titles typed, or filled in from a metadata lookup (MusicBrainz), matching the side's tracks to the release by their lengths.
- Click removal, short fades at the cuts, 24-bit FLAC (or 16-bit with dither), tags, and provenance in the library (`vinyl-rip` / `tape-transfer`).
- Recordings are kept until saved or deleted, so a side can be saved again or after a restart.
- A simulated input (WAV files) for tests.
