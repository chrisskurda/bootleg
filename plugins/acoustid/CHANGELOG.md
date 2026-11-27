# Changelog: AcoustID plugin

All notable changes to this plugin. It is versioned on its own, apart from the app ([docs/UPDATES.md](../../docs/UPDATES.md)). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-26
### Added
- Chromaprint-compatible fingerprints of the first two minutes of each track (pure Rust; no LGPL library).
- A metadata provider: an album's tracks looked up on AcoustID, and the MusicBrainz releases holding the most of them offered as candidates, with how many tracks were recognised.
- Your own AcoustID API key, kept in the keychain. At most three requests a second.
