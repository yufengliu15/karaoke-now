import math
import struct
import wave

import pytest


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: downloads model weights / long runtime")


@pytest.fixture
def wav_factory(tmp_path):
    """Synthesize a mono 16-bit sine-tone wav for pipeline tests."""

    def _make(name="tone.wav", seconds=1.0, freq=440.0, sr=16000):
        p = tmp_path / name
        n = int(seconds * sr)
        frames = b"".join(
            struct.pack("<h", int(20000 * math.sin(2 * math.pi * freq * i / sr)))
            for i in range(n)
        )
        with wave.open(str(p), "w") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(frames)
        return p

    return _make
