# Changelog: Plex plugin

All notable changes to this plugin. It is versioned on its own, apart from the app ([docs/UPDATES.md](../../docs/UPDATES.md)). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-26
### Added
- Sign in with plex.tv (PIN flow in the browser); the server is picked by name or is the first one, at the first of its addresses that answers (this network first, relays last). Only the server's access token is kept (system keychain).
- A server address instead, for a server on this network that allows access without signing in (or when plex.tv can't be reached).
- Music sections: tracks with tags, covers, bitrates; ratings in half stars both ways; playlists (read-only); "rescan" after bootleg writes tags.
- Music videos Plex keeps with each artist (local "-video" files), matched to tracks from any source. A setting turns the per-artist lookup off.
- Offline copies of the original files.
- Media streams through the desktop app's loopback proxy (Plex allows no other web origins).
