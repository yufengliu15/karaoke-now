"""Reference pitch contour extraction from the separated vocal stem.

Output is deliberately raw: f0 + confidence per 10ms frame, no voicing
threshold applied. What counts as "voiced" is a scoring-time decision
(see the project page's open questions), so the bundle keeps everything.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
HOP_MS = 10
HOP = SAMPLE_RATE * HOP_MS // 1000  # 160 samples
FMIN = 50.0
FMAX = 1100.0


def _load(vocals_wav: Path) -> np.ndarray:
    import librosa

    y, _ = librosa.load(vocals_wav, sr=SAMPLE_RATE, mono=True)
    return y


def extract(vocals_wav: Path, engine: str = "torchcrepe", fast: bool = False) -> dict:
    y = _load(vocals_wav)
    if engine == "torchcrepe":
        f0, conf = _torchcrepe(y, fast)
    elif engine == "pyin":
        f0, conf = _pyin(y)
    else:
        raise ValueError(f"unknown engine: {engine}")
    return {
        "version": 1,
        "engine": engine + ("-tiny" if engine == "torchcrepe" and fast else ""),
        "sample_rate": SAMPLE_RATE,
        "hop_ms": HOP_MS,
        "fmin": FMIN,
        "fmax": FMAX,
        "duration_s": round(len(y) / SAMPLE_RATE, 3),
        "f0_hz": [round(float(v), 2) for v in f0],
        "confidence": [round(float(v), 3) for v in conf],
    }


def _torchcrepe(y: np.ndarray, fast: bool) -> tuple[list, list]:
    import torch
    import torchcrepe

    audio = torch.from_numpy(y).float().unsqueeze(0)
    f0, periodicity = torchcrepe.predict(
        audio,
        SAMPLE_RATE,
        hop_length=HOP,
        fmin=FMIN,
        fmax=FMAX,
        model="tiny" if fast else "full",
        batch_size=512,
        device="cpu",
        return_periodicity=True,
    )
    return f0[0].tolist(), periodicity[0].tolist()


def _pyin(y: np.ndarray) -> tuple[list, list]:
    import librosa

    f0, _, voiced_prob = librosa.pyin(
        y, fmin=FMIN, fmax=FMAX, sr=SAMPLE_RATE, hop_length=HOP
    )
    f0 = np.nan_to_num(f0, nan=0.0)
    return f0.tolist(), voiced_prob.tolist()
