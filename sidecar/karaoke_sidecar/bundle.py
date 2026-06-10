"""Song bundle management: metadata probe, cache layout, meta.json."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import mutagen

BUNDLE_VERSION = 1


@dataclass
class SongMeta:
    id: str
    source_path: str
    title: str | None
    artist: str | None
    album: str | None
    duration_s: float


def song_id(audio_path: Path) -> str:
    h = hashlib.sha1()
    with open(audio_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def guess_from_filename(stem: str) -> tuple[str | None, str | None]:
    """'Artist - Title' filename convention; falls back to title-only."""
    parts = stem.split(" - ", 1)
    if len(parts) == 2:
        artist, title = parts[0].strip(), parts[1].strip()
        if artist and title:
            return artist, title
    return None, stem.strip() or None


def probe(audio_path: Path) -> SongMeta:
    f = mutagen.File(audio_path, easy=True)
    if f is None:
        raise ValueError(f"unrecognized audio file: {audio_path}")

    tags = f.tags or {}

    def tag(name: str) -> str | None:
        v = tags.get(name)
        if isinstance(v, (list, tuple)):
            v = v[0] if v else None
        v = str(v).strip() if v is not None else None
        return v or None

    artist, title, album = tag("artist"), tag("title"), tag("album")
    if not (artist and title):
        g_artist, g_title = guess_from_filename(audio_path.stem)
        artist = artist or g_artist
        title = title or g_title

    return SongMeta(
        id=song_id(audio_path),
        source_path=str(audio_path.resolve()),
        title=title,
        artist=artist,
        album=album,
        duration_s=float(f.info.length),
    )


def bundle_dir(songs_root: Path, sid: str) -> Path:
    d = Path(songs_root) / sid
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_meta(bdir: Path, meta: SongMeta, stages: dict) -> dict:
    doc = {
        "bundle_version": BUNDLE_VERSION,
        **asdict(meta),
        "stages": stages,
        "processed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    (bdir / "meta.json").write_text(json.dumps(doc, indent=2))
    return doc


def read_meta(bdir: Path) -> dict | None:
    p = bdir / "meta.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return None


def is_complete(meta_doc: dict | None) -> bool:
    """Lyrics are optional; a bundle is usable once separation + contour exist."""
    if not meta_doc:
        return False
    stages = meta_doc.get("stages", {})
    return stages.get("separate") == "done" and stages.get("contour") == "done"
