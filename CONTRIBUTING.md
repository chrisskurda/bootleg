# Contributing

## Changelog and versions
- Every user-visible change gets a line in `CHANGELOG.md` under **[Unreleased]**, in the same commit as the change. Use the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) groups: *Added, Changed, Deprecated, Removed, Fixed, Security*. Write for users, not for the diff.
- Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): **MAJOR** for incompatible changes (library/notes file formats, plugin or extension APIs), **MINOR** for new features, **PATCH** for fixes. While we are `0.x`, breaking changes bump MINOR.
- To release: rename **[Unreleased]** to `## [x.y.z] - YYYY-MM-DD`, add a fresh empty **[Unreleased]**, set the same version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (`npm run check:version` verifies this and runs in `npm test`/CI), commit, then tag `vx.y.z` — CI attaches the builds to the release.

## Tests
`npm test` (unit + browser end-to-end), `npm run perf` (performance budget), `scripts/selftest.sh <built app>` and `scripts/linux/test.sh` (desktop self-test).
