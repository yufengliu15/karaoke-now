import pytest

from karaoke_sidecar import contour


def _voiced_median(data, conf_threshold=0.5):
    voiced = [
        f for f, c in zip(data["f0_hz"], data["confidence"])
        if f > 0 and c > conf_threshold
    ]
    assert len(voiced) > 20, "expected a mostly-voiced contour for a pure tone"
    return sorted(voiced)[len(voiced) // 2]


def test_pyin_sine_440(wav_factory):
    data = contour.extract(wav_factory(seconds=1.0, freq=440.0), engine="pyin")
    assert data["hop_ms"] == 10
    assert len(data["f0_hz"]) == len(data["confidence"])
    assert abs(_voiced_median(data) - 440.0) < 10


def test_unknown_engine_rejected(wav_factory):
    with pytest.raises(ValueError):
        contour.extract(wav_factory(), engine="autotune")


@pytest.mark.slow
def test_torchcrepe_tiny_sine_440(wav_factory):
    data = contour.extract(wav_factory(seconds=1.0, freq=440.0), engine="torchcrepe", fast=True)
    assert data["engine"] == "torchcrepe-tiny"
    assert abs(_voiced_median(data) - 440.0) < 15
