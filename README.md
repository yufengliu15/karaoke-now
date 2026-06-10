# karaoke-now

Local-first karaoke desktop app for solo singing practice. Pick an mp3; the app strips the vocals, fetches time-synced lyrics, extracts the original vocal's pitch contour, then draws your live mic pitch against it while you sing. No accounts, no cloud, no leaderboards.

Project page (decisions, plan, open questions) lives in the Obsidian wiki: `Imagineer/_wiki/projects/local-karaoke/`.

## Stack

- **Electron** shell + renderer (UI, Web Audio mic capture, YIN-in-WASM live pitch detection in an AudioWorklet, canvas pitch lanes)
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

Click a library row to open the **playback screen**: instrumental audio, a scrolling reference pitch lane (canvas, semitone gridlines, now-line at 25%), and synced lyrics with the active line highlighted. Space or the button toggles play/pause; the slider seeks.

**Mic** turns on the live loop: your pitch is detected in real time (YIN compiled to WASM, running in an AudioWorklet, ~5ms updates) and drawn as green held-note bars over the reference — the same semitone quantization the reference lane uses, with a short median window plus onset/switch hysteresis so vibrato and scoops don't wiggle the bar. The transport shows the note you're holding.

The octave toggle picks the game you're playing: **Any octave** folds your pitch onto the melody, so only the note name has to match (sing it an octave down, still counts). **Exact octave** keeps your real register — sing an octave off and your bar drifts off the lane. First mic use prompts for macOS permission. Voice processing (echo cancellation, AGC) is disabled on the capture path — sing over headphones for best results, since the instrumental bleeding into the mic will confuse the detector.

The detector source lives in `wasm/yin.ts` (AssemblyScript); the compiled `renderer/worklet/yin.wasm` is committed, so `npm run build:wasm` is only needed after editing it.

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

# Lyrics lookup needs artist + title. If tags were missing (filename didn't
# match "Artist - Title"), retro-fetch without reprocessing the audio:
.venv/bin/python -m karaoke_sidecar.cli lyrics /path/to/songs/<id> --artist "The Jackson 5"
```

## Tests

```bash
cd sidecar
.venv/bin/python -m pytest               # fast suite
.venv/bin/python -m pytest -m slow       # + CREPE-tiny model download

npm test                                 # renderer: LRC parser + pitch-lane geometry
```

## Dev harness

The renderer + bundles are served over a privileged `app://` scheme (real origin, so ES modules / `fetch` / `<audio>` work under CSP). Env knobs, mainly for headless verification:

```bash
sidecar/.venv/bin/python scripts/make_synth_bundle.py   # fake bundle in /tmp/karaoke-test-songs
KARAOKE_SONGS_DIR=/tmp/karaoke-test-songs \
KARAOKE_SHOT_DIR=/tmp/karaoke-shots \
KARAOKE_SHOT_HASH="#play/deadbeefdeadbeef?t=12" \
KARAOKE_SHOT_PLAY=1 npx electron .       # screenshot + playback probe, then quits

# KARAOKE_FAKE_MIC=440 swaps the mic for a 440 Hz oscillator: the probe then
# clicks Mic, logs estimate counts + median f0, and the screenshot shows the
# live trace — the whole Phase 3 loop verified without a microphone.
```

## Status / roadmap

- [x] **Phase 1 — song pipeline**: file picker → cached bundle (this repo, 2026-06-10)
- [x] **Phase 2 — playback screen**: instrumental + scrolling lyrics + reference pitch lane (2026-06-10)
- [x] **Phase 3 — live mic loop**: AudioWorklet + YIN-WASM, user pitch line over reference, <50ms mic-to-pixel (2026-06-10)
- [ ] **Phase 4 — scoring**: in-tune-percent per phrase + session summary
- Post-MVP: yt-dlp ingest, WhisperX forced-alignment fallback, key transposition
