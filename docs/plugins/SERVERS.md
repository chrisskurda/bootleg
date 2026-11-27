# Jellyfin and Plex sources

Two packaged source plugins (plugin spec §5 `api.sources.register`), each with its own version and CHANGELOG ([Jellyfin](../../plugins/jellyfin/CHANGELOG.md), [Plex](../../plugins/plex/CHANGELOG.md)). Turn one on in *Settings → Plugins*, then *Settings → library → Connect a server or service…*. Their tracks join that library like Subsonic's (cached, rescanned, rated, noted, kept offline, synced to cards), and their music videos join the Videos page ([VIDEOS.md](../VIDEOS.md)).

Turning a plugin off takes its tracks and videos out of the library; the connection, its keychain entry and the cache stay, and turning it on again brings them back at once, without asking the server.

## Jellyfin (`plugins/jellyfin`, plain JS)
- **Sign-in:** server address, username, password. The password is used once (`/Users/AuthenticateByName`); only the access token is kept, in the keychain. Each connection has its own device id, so it shows (and can be revoked) under Jellyfin's *Devices*.
- **Scan:** Audio and MusicVideo items in one paged walk (500 at a time): title, artists, album artist, album, track and disc, year, genre, length, size, bitrate, the file path, favourite, the album cover.
- **Favourites** both ways (the bootleg tag `starred`). Jellyfin has no star ratings, so bootleg ratings stay in bootleg.
- **Playlists** (read-only), **rescan** after bootleg writes tags into the files.
- **Offline copies:** the original (`/Items/{id}/Download`), or MP3 320/128 converted by the server.
- **Videos:** MP4/WebM/MOV with web codecs stream as they are; anything else (MKV, HEVC …) is remuxed or converted to MP4 by the server. Without an `.nfo`, Jellyfin names a music video after its file; bootleg reads "Artist - Title" from that.
- Jellyfin allows any origin, so it plays in the web build too.

## Plex (`plugins/plex`, plain JS)
- **Sign-in:** *Connect* opens plex.tv in the browser (the PIN flow): sign in there and allow bootleg. bootleg then picks the server (the *Server name* field, or the first one, owned servers first) and the first of its addresses that answers: on this network first, relays last. Only that server's access token is kept (keychain), not the plex.tv account token.
- **Server address** instead: for a server on this network that allows access without signing in (Plex's *List of IP addresses and networks that are allowed without auth*), or when plex.tv can't be reached. If that server wants a sign-in after all, the PIN flow runs and the account's server with that identity is used.
- **Scan:** every music section, tracks paged (title, track artist and album artist, album, track and disc, year, genre, length, size, bitrate, file path, rating, cover), then the music videos Plex keeps with each artist (local `<title>-video.mp4` files and the like), a few artists at a time. *Settings → Plugins → Plex → Music videos* turns that per-artist lookup off for big libraries.
- **Ratings** in half stars both ways (Plex keeps 0–10). Plex has no favourites, so the `starred` tag stays in bootleg.
- **Playlists** (audio, read-only), **rescan** (every music section).
- **Offline copies:** originals only (Plex converts only through its player profiles).
- **Playing:** Plex allows only app.plex.tv as a web origin, so the desktop app streams its media through the loopback media proxy (`src-tauri/src/proxy.rs`). The web build lists a Plex library but can't play it.

## Not yet
- Jellyfin Quick Connect; Plex Home users and managed users; switching a Plex connection to another of the server's addresses when the chosen one stops answering (connect again for now).
- Plex conversions (offline High/Space saver, videos the platform can't play).
- Writing playlists back; Jellyfin's "likes".
- Checked against real servers in throwaway Docker containers (Jellyfin 10.10.7; Plex Media Server 1.43.5, unclaimed): not against anyone's real library, and the plex.tv sign-in only against a mock.

## Testing
- `node plugins/jellyfin/jellyfin.test.mjs`: sign-in (and a wrong password), the paged scan with tracks and videos, stream and cover URLs, favourites, playlists, offline copies, an expired token. With `BOOTLEG_JELLYFIN_URL`, `_USER`, `_PASS` it also runs against a real server: scan, ranged streams (the remuxed MKV too), covers without the token, favourites, playlists.
- `node plugins/plex/plex.test.mjs`: the PIN flow (opening plex.tv, polling, the server token rather than the account's, the address that answers, a missing server name, approval that never comes), an address without sign-in, the scan with paging and artist extras, ratings, playlists, covers, offline copies, the video setting. With `BOOTLEG_PLEX_URL` it also runs against a real server: scan, ranged streams, covers, a rating round trip.
- The browser test connects Jellyfin (mock server) from Settings, plays a track, plays its music video for a Subsonic track, gets its playlist, and turns the plugin off and on.
- The desktop self-test plays a Plex track and music video (mock server that allows only app.plex.tv) through the media proxy and checks they are heard.
