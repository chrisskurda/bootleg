# Changelog: Jellyfin plugin

All notable changes to this plugin. It is versioned on its own, apart from the app ([docs/UPDATES.md](../../docs/UPDATES.md)). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-26
### Added
- Connect with a server address, username and password; only the access token is kept (system keychain).
- Music (tracks with tags, album covers, bitrates) and music videos in one scan, paged.
- Favourites both ways (Jellyfin has no star ratings), playlists (read-only), "rescan" after bootleg writes tags.
- Offline copies: the original file, or MP3 320/128 converted by the server.
- Music videos in MP4/WebM/MOV with web codecs stream as they are; others (MKV, HEVC, …) are remuxed or converted to MP4 by the server.
