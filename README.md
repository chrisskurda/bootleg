# bootleg

An audio player that plays **standard tracks** (mp3, flac, m4a, ogg, wav — with their tags and cover art) and **stem renders** (the MusicGen
format: `stems/`, `manifest.json`, `clips.json`), with per-stem mute / solo / trim, and runs
[bootleg-vizualizer](https://git.skurda.org/chris/bootleg-vizualizer.git) visualizers live — including per-stem visuals and text.

JavaScript app for the browser, wrapped with **Tauri** for desktop. MIT licensed.

> **Status: scaffold.** Nothing runs yet. The plan and open questions are in [docs/PLAN.md](docs/PLAN.md); the starting point for the stem player is
> the audition page in MusicGen (`audition/template.html`).

## Vendored
`vendor/bootleg-vizualizer/` is a pinned `git subtree` of the visualizer (spec, runtime, FX, packs, analysis). Don't edit it here — change it in
bootleg-vizualizer and pull: `git subtree pull --prefix vendor/bootleg-vizualizer https://git.skurda.org/chris/bootleg-vizualizer.git <tag> --squash`.

## Related
- [bootleg-vizualizer](https://git.skurda.org/chris/bootleg-vizualizer.git) — the pack format, runtime and packs
- [bootleg-vizualizer-videocreator](https://git.skurda.org/chris/bootleg-vizualizer-videocreator.git) — renders packs to video
- MusicGen / RiffBox — makes the stem renders this player opens
