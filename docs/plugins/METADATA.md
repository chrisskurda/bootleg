# Metadata plugins: MusicBrainz and AcoustID

Both plug into the app's metadata providers (plugin spec §6 `api.metadata.register`, `src/lib/metadata.js`). Each has its own version and CHANGELOG ([MusicBrainz](../../plugins/musicbrainz/CHANGELOG.md), [AcoustID](../../plugins/acoustid/CHANGELOG.md)). Both are experimental until they have been used on real libraries.

## How it works in the app
- In the albums' split view, the album pane has **Find details online…** when any provider is on. Nothing is looked up until it is pressed.
- Every provider is asked at once. Their candidates are listed best first, with a cover, a summary and a match score. A provider that fails shows its error without stopping the others.
- **This one** remembers the release for the album (IndexedDB, so it shows offline afterwards). Its facts (label, catalogue number, barcode, release type, country, genres …) join the album's details where the album doesn't already have them, each with the provider as its source chip. Its cover stands in when the files have none.
- **Edit album** then has *Fill in from MusicBrainz*. It fills the album-wide fields (album, album artist, year, genre) for you to check before saving. As with every tag edit, it is saved in bootleg and the files are left alone until you choose to write tags.
- *change* looks the album up again; *forget* drops the chosen release.

## MusicBrainz (`plugins/musicbrainz`, plain JS)
- Searches releases by album title and artist, then looks the best four up in full, so they can be scored on their track list.
- **Score:** MusicBrainz's text match (35%), how well the tracks fit (55%: the count, and how many lengths are within 3 seconds) and the year (10%). A disc looked up by its disc id (`kind: 'disc'`) scores 1.
- Covers come from the Cover Art Archive (250 px in the list).
- At most one request a second, and a 503 is retried once, as MusicBrainz asks. The User-Agent is `bootleg/<version>`. It sends no contact address, since that would identify the user; one can be added if MusicBrainz ever asks for it.

## AcoustID (`plugins/acoustid`, JS + native)
For albums whose tags say too little to search by.
- The native part (`bootleg-plugin-acoustid`) fingerprints the first two minutes of each local track. It uses `rusty-chromaprint` (MIT, a Rust port of Chromaprint; the LGPL C library isn't used), and the print is compressed and base64-encoded exactly as `fpcalc` prints it.
- Each print is looked up on AcoustID (three requests a second at most). The MusicBrainz releases that hold the most of the album's tracks become candidates. A track found at its own position on a release is a full vote, elsewhere on it half a vote. The score is the share of the album's tracks heard, lowered a little when the release has a different number of tracks (so a compilation ranks below the album).
- **Needs an AcoustID API key:** register an application at acoustid.org (free, with a MusicBrainz account) and paste the key into *Settings → Plugins → AcoustID*. It is kept as a secret. bootleg can get a key of its own later, as with Last.fm.
- Server tracks can't be fingerprinted (no local file).

## Testing
- `node plugins/musicbrainz/musicbrainz.test.mjs`: releases → candidates, scoring, the rate limiter, the plugin through the app's registry, the chosen release in the album details and in the tag editor's suggestions.
- `node plugins/acoustid/acoustid.test.mjs`: the votes and scores, errors, and the plugin with mocked fingerprints and responses.
- `cargo test --manifest-path plugins/acoustid/native/Cargo.toml`: the same tune at two sample rates matches and a different tune doesn't; a file's print has the `fpcalc` format and covers 120 s; and the whole length is reported.
- The browser test looks an album up against a mocked MusicBrainz, picks the release, checks the facts and the tag editor, and turns the plugin off. The desktop self-test fingerprints a real file.
- Neither service has been called for real from these tests.

## Later
- Single tracks (`kind: 'recording'`): identify one file by sound from the tag editor, and fill in per-track titles and MusicBrainz ids.
- The CD plugin using the MusicBrainz provider instead of its own lookup.
- Discogs, and Last.fm for artist bios.
