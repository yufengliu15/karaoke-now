"""karaoke-now sidecar CLI.

Protocol: stdout carries one JSON object per line ({stage, status, ...}),
consumed by the Electron host. All human noise (Demucs progress, warnings,
tracebacks) goes to stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

from . import bundle, contour, lyrics, separate


def emit(stage: str, status: str, **extra) -> None:
    print(json.dumps({"stage": stage, "status": status, **extra}), flush=True)


def process(args: argparse.Namespace) -> int:
    audio = args.audio.resolve()
    if not audio.exists():
        emit("probe", "error", message=f"file not found: {audio}")
        return 2

    emit("probe", "start", file=str(audio))
    meta = bundle.probe(audio)
    bdir = bundle.bundle_dir(args.out, meta.id)
    emit(
        "probe", "done",
        id=meta.id, title=meta.title, artist=meta.artist,
        duration_s=meta.duration_s, bundle=str(bdir),
    )

    if bundle.is_complete(bundle.read_meta(bdir)) and not args.force:
        emit("bundle", "done", cached=True, bundle=str(bdir))
        return 0

    stages: dict[str, str] = {}

    emit("separate", "start", model=args.model)
    separate.two_stems(audio, bdir, model=args.model)
    stages["separate"] = "done"
    emit("separate", "done")

    emit("contour", "start", engine=args.engine)
    data = contour.extract(bdir / "vocals.wav", engine=args.engine, fast=args.fast)
    (bdir / "contour.json").write_text(json.dumps(data))
    stages["contour"] = "done"
    emit("contour", "done", frames=len(data["f0_hz"]))

    emit("lyrics", "start")
    if args.skip_lyrics:
        stages["lyrics"] = "skipped"
        emit("lyrics", "done", found=False, skipped=True)
    else:
        try:
            lrc = lyrics.fetch_synced(meta.artist, meta.title, meta.duration_s, meta.album)
        except Exception as e:  # network failure must not kill the bundle
            lrc = None
            emit("lyrics", "warn", message=str(e))
        if lrc:
            (bdir / "lyrics.lrc").write_text(lrc)
            stages["lyrics"] = "done"
            emit("lyrics", "done", found=True)
        else:
            stages["lyrics"] = "none"
            emit("lyrics", "done", found=False)

    bundle.write_meta(bdir, meta, stages)
    emit("bundle", "done", cached=False, bundle=str(bdir))
    return 0


def retrofit_lyrics(args: argparse.Namespace) -> int:
    emit("lyrics", "start", bundle=str(args.bundle))
    found = lyrics.retrofit(args.bundle, artist=args.artist, title=args.title)
    emit("lyrics", "done", found=found)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="karaoke-sidecar", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    proc = sub.add_parser("process", help="process an audio file into a song bundle")
    proc.add_argument("audio", type=Path)
    proc.add_argument("--out", type=Path, required=True, help="songs cache root")
    proc.add_argument("--model", default=separate.DEFAULT_MODEL, help="demucs model name")
    proc.add_argument("--engine", choices=["torchcrepe", "pyin"], default="torchcrepe")
    proc.add_argument("--fast", action="store_true", help="tiny crepe model (faster, rougher)")
    proc.add_argument("--force", action="store_true", help="reprocess even if cached")
    proc.add_argument("--skip-lyrics", action="store_true")

    lyr = sub.add_parser("lyrics", help="re-fetch synced lyrics into an existing bundle")
    lyr.add_argument("bundle", type=Path, help="bundle directory (songs/<id>)")
    lyr.add_argument("--artist", help="override missing/wrong artist tag")
    lyr.add_argument("--title", help="override missing/wrong title tag")

    args = p.parse_args(argv)
    try:
        if args.cmd == "lyrics":
            return retrofit_lyrics(args)
        return process(args)
    except Exception as e:
        traceback.print_exc()
        emit("fatal", "error", message=str(e))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
