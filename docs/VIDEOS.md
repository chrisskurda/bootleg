# Music videos

A music video can come from any source and go with a track from any source: a video file in a folder, on a Jellyfin or Plex server, or later YouTube; a track from a folder, Subsonic, Jellyfin, Plex or a stem server. Code: `src/lib/videos.js` (matching and links, no DOM), `src/lib/videos-ui.js` (the Videos page, Now playing, the link dialog), the player (`player.videoEl`, `videoMode`, `watch()`), and `src/screen.js` (visualizer screens).

## Where videos come from
- **Folders:** MP4, M4V, MKV, WebM and MOV files are videos, not tracks. Artist and title come from the file name, `Artist - Title.mp4` (anything else is just a title). The browser and the desktop webviews play MP4/H.264 and WebM reliably; MKV and HEVC depend on the platform.
- **Source plugins:** Items with `kind: 'video'` ([SOURCE-PLUGINS.md](SOURCE-PLUGINS.md)). A video without an artist whose title reads "Artist - Title" is split the same way (Jellyfin without an `.nfo`, YouTube titles).
- They are listed on the **Videos** page (shown once there is a video), searchable like tracks, and play from there on their own.

## Which video goes with which track
- **Automatically:** the same first credited artist and the same title once upload decorations are gone: brackets with *official, video, HD, 4K, lyrics, audio, remastered…*, "– Official Video" tails, *feat.* credits, accents, punctuation, a leading "The". `(Live)` and remixes stay, as they are other recordings.
- **By hand:** the 🎬 chip on a track row (or *link a video…* on Now playing) opens a dialog: the track's videos, with *Watch*, *unlink* or *not this one*, and every video to link, best guesses first.
- *not this one* hides an automatic match for that track (it doesn't come back on the next scan); *Show … again* undoes it.
- Links are kept by the track's annotation key (the one notes use), so they follow a server track across rescans. They are stored in IndexedDB (`bootleg-videos`) on this computer; they are not yet in the notes export or synced.

## Playing
- A video plays **with its own sound** (decided 2026-11-26: a video's edit seldom lines up with the album version). Its sound goes through the same path as a track's, so the visualizer, extension inserts (the equalizer) and the volume work on it.
- **Now playing:** *Watch the video* (or one button per video when there are several) plays it in place of the track's sound, on a stage above the track's details; *Back to the track* returns. Double-click or ⛶ for full screen.
- **Play music videos** (the switch on Now playing): every track with a video plays its video instead, through the whole queue. Remembered.
- The queue item stays the track: plays, notes and ratings count for it. The track's timeline (spectrogram, note callouts, listening heat) is hidden while its video plays, since the video runs on another clock, and listening heat isn't recorded then.
- No gapless or crossfade into or out of a video: it ends, and the next one loads.
- **Visualizer screens** (*Show on another screen*): with *Settings → Music videos on visualizer screens* (on by default), a screen shows the video instead of the visualizer: silently, following the player's position. When the track plays rather than its video, the linked video is the picture and loops. The visualizer comes back for tracks without a video.

## Servers that don't allow other origins
The player's media elements load with CORS so their sound can reach the audio graph. Jellyfin allows any origin. Plex allows only `app.plex.tv`: its source sets `cors: false` and the desktop app streams it through a **loopback media proxy** (`src-tauri/src/proxy.rs`: `127.0.0.1` only, random token per registered URL, Range passed through). The web build can't play such a server.

## Not yet
- Videos in the casting (DLNA) path: casting plays the track's audio, not its video.
- Videos inside the in-app Visualizer page (only the screens).
- Links in the notes export and device sync; a "videos" filter or smart list.
- `.nfo` files for music videos (Kodi's `<musicvideo>`).
- Plex/Jellyfin conversion of videos the platform can't play (Jellyfin remuxes MKV and others to MP4 already; Plex videos play as they are).
- YouTube as a video source (a later plugin).

## Testing
- `node tests/videos.test.mjs`: title and artist matching, file names, links, hiding, the picker.
- The browser test (`tests/app.test.mjs`): videos from a folder, the Videos page, the 🎬 chip, *Watch the video* / *Back to the track*, video mode across a queue, linking by hand, *not this one*, a video on its own, a visualizer screen with and without the option; and a Jellyfin music video (mock server) matched to and played for a Subsonic track.
- The desktop self-test: a local MP4 linked to a track plays with sound through the asset protocol; a Plex track and video play through the media proxy with sound (mock Plex that allows only app.plex.tv).
