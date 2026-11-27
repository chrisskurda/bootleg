# Scrobbling plugin

`plugins/scrobble`, plain JS (no native part), plugin spec 2.0. Its own version and [CHANGELOG](../../plugins/scrobble/CHANGELOG.md).

## Setting it up
*Settings → Plugins → Scrobbling*: turn it on (it is experimental, so it asks first), then:
- **ListenBrainz:** paste your user token (listenbrainz.org → Settings → User token).
- **Last.fm:** bootleg has no Last.fm API account of its own yet, so enter your own key and shared secret ([create one](https://www.last.fm/api/account/create); any name and description will do). Then open the **Scrobbling** page, press *Sign in to Last.fm…*, allow bootleg in the browser, and press *Finish signing in*.

All of these are kept as secrets in the system keychain ([SECRETS.md](../SECRETS.md)). The Last.fm password is never seen by bootleg; only the session key Last.fm hands back is kept.

## What counts
- A track counts once **half of it or 4 minutes**, whichever is less, has really been heard. Pauses, seeks and skipped stretches don't count. A track of 30 seconds or less never counts. An unknown length needs 4 minutes.
- The listen's time is when the track started. Playing it again from the top is a new listen.
- Stem sets count only with *Scrobble stem sets* on. *Pause* on the page stops counting altogether.
- What is sent: artist (or album artist), title, album, length, track number, and the MusicBrainz recording and release ids and ISRC when the tags have them.

## Sending
- Listens go into a queue kept in the plugin's settings, so they survive a restart or a time offline, and are sent oldest first, in batches (ListenBrainz 100, Last.fm 50).
- A failed send waits 1, 2, 4 … minutes (at most an hour) before trying again. ListenBrainz's rate limit is respected.
- A batch a service refuses is retried one listen at a time; only the listen that is refused is dropped, and the page's log says which.
- A token or session that stops working stops sending for that service. The listens wait until you fix it.
- "Now playing" is best effort and never queued.

## Testing
`node plugins/scrobble/scrobble.test.mjs` covers the counting, both services' request formats, Last.fm signing, the queue, and the whole plugin against mocked services. The browser test turns it on, saves a token through Settings and checks it signs in, against a mocked ListenBrainz.

| Service | Checked | Result |
|---|---|---|
| ListenBrainz | not yet against the real service | |
| Last.fm | not yet against the real service | |

## Later
- Plays made on a bootleg-pod handheld arrive with device sync (the outbox). Scrobble them with their real times.
- A bootleg Last.fm API account, so the key and secret fields can go.
- Love/unlove ↔ the bootleg `starred` tag; a tag such as `no-scrobble` to keep a track or album out.
