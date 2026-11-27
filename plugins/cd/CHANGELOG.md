# Changelog: CD plugin

All notable changes to this plugin. It is versioned on its own, apart from the app ([docs/UPDATES.md](../../docs/UPDATES.md)). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-26
### Added
- Secure ripping on macOS (experimental): every sector read until two reads agree, with the drive cache flushed in between, and slowed down for sectors that won't settle.
- AccurateRip verification, with the read offset from AccurateRip's drive list. MusicBrainz tags and cover art.
- FLAC (decoded back and compared before it is kept), WAV and AIFF. Cue sheet, playlist, and a log in text and JSON.
- Damaged discs: what can't be read is filled in and flagged as defects in the library.
- Check drive. A simulator backend for tests.
