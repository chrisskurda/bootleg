# Changelog: MusicBrainz plugin

All notable changes to this plugin. It is versioned on its own, apart from the app ([docs/UPDATES.md](../../docs/UPDATES.md)). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-26
### Added
- A metadata provider: albums looked up by title and artist (and discs by disc id), only when asked.
- Releases scored by MusicBrainz's match, how well the tracks fit (count and lengths) and the year; the best four are looked up in full.
- Release date, country, label, catalogue number, barcode, release type, format, status and genres; Cover Art Archive covers; tag suggestions.
- At most one request a second, as MusicBrainz asks.
