"""Two-stem vocal separation via Demucs, run as a subprocess of this interpreter."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_MODEL = "htdemucs"


def two_stems(audio_path: Path, bdir: Path, model: str = DEFAULT_MODEL) -> None:
    """Run Demucs, leaving instrumental.wav + vocals.wav in the bundle dir.

    Demucs progress goes to our stderr so the sidecar's stdout stays a clean
    JSON protocol for the Electron host.
    """
    with tempfile.TemporaryDirectory(prefix="karaoke-demucs-") as tmp:
        cmd = [
            sys.executable, "-m", "demucs",
            "--two-stems", "vocals",
            "-n", model,
            "-o", tmp,
            str(audio_path),
        ]
        subprocess.run(cmd, check=True, stdout=sys.stderr)
        stem_dir = Path(tmp) / model / audio_path.stem
        shutil.move(str(stem_dir / "vocals.wav"), bdir / "vocals.wav")
        shutil.move(str(stem_dir / "no_vocals.wav"), bdir / "instrumental.wav")
