# karaoke-now

Local-first karaoke desktop app for solo singing practice. Pick an mp3; the app strips the vocals, fetches time-synced lyrics, extracts the original vocal's pitch contour, then (Phase 3) draws your live mic pitch against it while you sing. No accounts, no cloud, no leaderboards.

Project page (decisions, plan, open questions) lives in the Obsidian wiki: `Imagineer/_wiki/projects/local-karaoke/`.

## Stack

- **Electron** shell + renderer (UI, later: Web Audio capture + YIN-in-WASM live pitch detection in an AudioWorklet)
- **Python sidecar** for the offline pipeline: [Demucs](https://github.com/facebookresearch/demucs) two-stem separation, [torchcrepe](https://github.com/maxrmorrison/torchcrepe) reference pitch contour, [LRClib](https://lrclib.net) synced lyrics
- Sidecar speaks a JSON-lines protocol on stdout; Electron streams it into the UI

## Setup

```bash
# 1. JS side
npm install

# 2. Python sidecar (3.11+; tested on 3.13)
cd sidecar
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

`ffmpeg` recommended for mp3/m4a decoding (`brew install ffmpeg`).

## Run

```bash
npm start
```

"Add song" → pick an audio file → watch the pipeline chips (tags → Demucs → pitch → lyrics → bundle). First run downloads Demucs/CREPE model weights. The `fast` toggle uses CREPE-tiny for a quicker, rougher contour.

Bundles land in Electron's `userData/songs/<id>/`:

```
instrumental.wav   # what you sing over
vocals.wav         # separated reference vocal
contour.json       # f0 + confidence per 10ms frame (raw, no voicing threshold)
lyrics.lrc         # synced lyrics, when LRClib has them
meta.json          # tags, duration, stage statuses
```

## Sidecar CLI (without Electron)

```bash
cd sidecar
.venv/bin/python -m karaoke_sidecar.cli process "Artist - Title.mp3" --out /tmp/songs
# flags: --fast  --engine {torchcrepe,pyin}  --force  --skip-lyrics  --model htdemucs
```

## Tests

```bash
cd sidecar
.venv/bin/python -m pytest               # fast suite
.venv/bin/python -m pytest -m slow       # + CREPE-tiny model download
```

## Status / roadmap

- [x] **Phase 1 — song pipeline**: file picker → cached bundle (this repo, 2026-06-10)
- [ ] **Phase 2 — playback screen**: instrumental + scrolling lyrics + reference pitch lane
- [ ] **Phase 3 — live mic loop**: AudioWorklet + YIN-WASM, user pitch line over reference, <50ms mic-to-pixel
- [ ] **Phase 4 — scoring**: in-tune-percent per phrase + session summary
- Post-MVP: yt-dlp ingest, WhisperX forced-alignment fallback, key transposition
