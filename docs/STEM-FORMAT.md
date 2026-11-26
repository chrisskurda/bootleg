# The bootleg stem format

> **Version 2 and the canonical spec live with the stem server:** `contracts/song_format.md` in
> [bootleg-stemserver](https://git.skurda.org/chris/bootleg-stemserver) — `.bstem` (a song with its stems in one file) and
> `.bsong` (the same plus bootleg Composer's project and its history), permanent song ids. bootleg reads both, and the
> version-1 folders described below, which remain valid.

A **stem set** is one piece of music delivered as its parts: separate audio files for each instrument or layer (the *stems*), usually with the finished mix beside them and a little metadata. bootleg shows a stem set as **one item** in the library — the stems and the mix are never listed as separate tracks — plays it instantly from the mix, and loads the stems on demand for the stem mixer and stem-aware visualizers.

The format is deliberately small and forgiving: everything except the stems is optional, and unknown fields are ignored, so tools can add their own. Version 1 describes what bootleg reads today.

## Layout

```
<set>/                       one folder per piece of music
  mix.flac                   the finished mix (mix.* / master.* / final.* / bounce.*; any audio type) — optional, recommended
  stems/
    kick.flac  snare.flac  hats.flac  bass.flac  pad.flac  lead.flac …
  manifest.json              optional: title, tempo, key, length, per-stem gain, sections
  clips.json                 optional: which sample/clip plays on which stem and when (text for visualizers)
  provenance.json            optional, free-form: how it was made (ignored by players)
```

- **Stems** are audio files (`flac`, `wav`, `mp3`, `m4a`, `ogg`, `opus`, `aif`, `caf`). The file name without its extension is the stem's **name** (`kick`, `808`, `vox`, `smp_fx`…). All stems should be the same length and start at the same instant (sample-aligned), so they sum to the mix.
- **The mix** is what plays first: one file, instant start, small memory. Without a mix, the stems are decoded and summed at play time.
- Stem sets are recognised by a **`stems/`** folder with two or more audio files (a `manifest.json` also qualifies one), or as a **loose set**: a folder whose audio files are (at least 60%) stem-named — kick, snare, hats, bass, sub, lead, pad, arp, keys, vox, fx, perc, drums, bed… — optionally with a `musicset.json` and/or `mix.*`. Ordinary albums are left alone: a stem word must be the *whole* file name.

## Roles
A stem's **role** is inferred from its name and drives role-specific visuals (a kick draws rings, hats sparkle): `kick`/`bd`, `snare`/`sd`/`clap`, `hats`/`hat`/`hh`, `perc`, `drums`, `bass`/`sub`/`808`, `keys`/`piano`/`rhodes`, `lead`/`arp`, `pad`/`strings`, `vocals`/`vox`, `fx`/`crash`/`riser`, `sample`; anything else is `other`. (The table lives in the visualizer: `VisStems.roleOf`.)

## manifest.json (all fields optional)
| field | meaning |
|---|---|
| `format`, `version` | `"bootleg-stem"` and `1`. Written by producers so tools can recognise the format; a missing value means version 1 |
| `name` / `title` | the piece's title (the mix's tags win when present; otherwise the folder name is used) |
| `bpm` | tempo; also converts `clips.json` bars to seconds |
| `key` / `key_label` | musical key, e.g. `f#m` |
| `seconds` | length in seconds |
| `stems_gain_db` | `{ "<stem name>": dB }` — the mix-balance gain of each stem; the mixer starts from these |
| `sections` | `[{ "name": "intro", "start_s": 0, "end_s": 6.2 }, …]` |

## clips.json (optional)
Tells visualizers *what is playing* on each stem, so a pack can show text like “Hats Closed 120”:
```json
{ "bpm": 132, "clips": [
  { "kind": "loop", "stem": "hats", "file": "kits/Hats2_126.wav", "kit": 3, "start_bar": 0, "bars": 16 },
  { "kind": "hit",  "stem": "snare", "file": "kits/Clap_01.wav", "start_s": 12.5, "length_s": 0.4 } ] }
```
Loops are placed in bars of four beats (`start_bar`, `bars`), hits in seconds. `file` becomes the label (its folder is ignored); `kit` is optional. Any other fields are ignored. It is loaded when the set is played, not when the library is scanned.

## What bootleg does with a set
- Lists it once (artist/album/year/genre/cover come from the **mix's tags**; a manifest supplies tempo, key, sections).
- Plays the mix at once; loads the stems when a stem-aware visualizer (`usesStems` in `pack.json`) is shown, when you press *Load stems*, or always — your choice in Settings → Stem sets — and hands over at the same position.
- Casting plays the mix. Mute/solo/trim apply to the local stem mixer only.

## For producers
Write `mix.flac` and `stems/*.flac`, add `manifest.json` with `"format": "bootleg-stem", "version": 1` plus whatever you know (bpm, key, seconds, `stems_gain_db`, sections), tag the mix (title, artist, album, year, cover), and add `clips.json` if you want visualizers to name the samples. A folder written this way — or any folder with a `stems/` directory — is picked up automatically.
