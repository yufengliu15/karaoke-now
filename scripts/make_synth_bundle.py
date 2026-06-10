"""Synthetic song bundle for karaoke-now player-view verification.

C-major melody, 0.45s notes with 0.15s gaps, light vibrato on the contour,
handwritten LRC every ~2.4s. Audio is a quiet chord pad (content irrelevant,
must merely be a valid wav).
"""

import json
import time
import wave
from pathlib import Path

import numpy as np

SR = 16000
DUR = 30.0
HOP_MS = 10
ROOT = Path("/tmp/karaoke-test-songs/deadbeefdeadbeef")
ROOT.mkdir(parents=True, exist_ok=True)

# --- instrumental.wav: soft I-vi-IV-V pad, 2s per chord -------------------
t = np.arange(int(SR * DUR)) / SR
chords = [(261.63, 329.63, 392.0), (220.0, 261.63, 329.63),
          (174.61, 220.0, 261.63), (196.0, 246.94, 293.66)]
audio = np.zeros_like(t)
for i in range(int(DUR // 2) + 1):
    f1, f2, f3 = chords[i % 4]
    seg = (t >= i * 2) & (t < (i + 1) * 2)
    for f in (f1, f2, f3):
        audio[seg] += 0.08 * np.sin(2 * np.pi * f * t[seg])
pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
with wave.open(str(ROOT / "instrumental.wav"), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())

# --- contour.json: looping melody with vibrato, gaps between notes --------
MELODY = [60, 62, 64, 65, 67, 69, 67, 64, 62, 60]  # C4 run up and back
NOTE_S, GAP_S = 0.45, 0.15
n_frames = int(DUR * 1000 / HOP_MS)
f0 = np.zeros(n_frames)
conf = np.full(n_frames, 0.05)
step = NOTE_S + GAP_S
for k in range(int(DUR / step)):
    midi = MELODY[k % len(MELODY)]
    start = k * step
    fr0, fr1 = int(start * 100), int((start + NOTE_S) * 100)
    frames = np.arange(fr0, min(fr1, n_frames))
    vib = 0.25 * np.sin(2 * np.pi * 5.5 * (frames / 100.0))  # ±25 cents, 5.5 Hz
    f0[frames] = 440.0 * 2 ** ((midi - 69 + vib) / 12)
    conf[frames] = 0.95
(ROOT / "contour.json").write_text(json.dumps({
    "version": 1, "engine": "synthetic", "sample_rate": SR, "hop_ms": HOP_MS,
    "fmin": 50.0, "fmax": 1100.0, "duration_s": DUR,
    "f0_hz": [round(float(v), 2) for v in f0],
    "confidence": [round(float(v), 3) for v in conf],
}))

# --- lyrics.lrc ------------------------------------------------------------
LINES = [
    "Climbing up the scale tonight",
    "Every note a little light",
    "Hold the line and watch it glide",
    "Pitch and melody side by side",
    "Down we come the gentle way",
    "Singing what the contours say",
    "One more pass around the sun",
    "Practice makes the music run",
    "Watch the lane and let it flow",
    "This is karaoke now",
    "",
    "Take a breath the song is done",
]
lrc = "[ar:Karaoke Now]\n[ti:Synthetic Test Song]\n"
for i, line in enumerate(LINES):
    sec = i * 2.4
    lrc += f"[{int(sec // 60):02d}:{sec % 60:05.2f}] {line}\n"
(ROOT / "lyrics.lrc").write_text(lrc)

# --- meta.json --------------------------------------------------------------
(ROOT / "meta.json").write_text(json.dumps({
    "bundle_version": 1, "id": "deadbeefdeadbeef",
    "source_path": "/tmp/synthetic.mp3", "title": "Synthetic Test Song",
    "artist": "Karaoke Now", "album": None, "duration_s": DUR,
    "stages": {"separate": "done", "contour": "done", "lyrics": "done"},
    "processed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
}, indent=2))

print("bundle:", ROOT)
