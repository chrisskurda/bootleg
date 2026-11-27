# Changelog: Scrobbling plugin

All notable changes to this plugin. It is versioned on its own, apart from the app ([docs/UPDATES.md](../../docs/UPDATES.md)). Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-26
### Added
- ListenBrainz (user token) and Last.fm (your own API key and secret, then sign in on the Scrobbling page).
- A track counts once half of it, or 4 minutes, has really been heard: pauses, seeks and skips don't count, and tracks of 30 seconds or less never do. Playing it again from the top counts again.
- "Now playing" as a track starts (can be turned off).
- Listens wait in a queue kept across restarts and are sent oldest first, in batches. Failures back off from 1 minute up to an hour; a listen a service refuses is dropped and logged.
- Stem sets are left out unless you choose otherwise. A pause switch on the page.
- Tokens, keys and the Last.fm session are secrets (system keychain).
