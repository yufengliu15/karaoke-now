"""Time-synced lyrics from LRClib (https://lrclib.net).

MVP decision (project page, 2026-06-10): LRClib is the only lyrics path.
Synced lyrics or nothing; a missing result is a normal outcome, not an error.
"""

from __future__ import annotations

import json
from pathlib import Path

import requests

API_BASE = "https://lrclib.net/api"
USER_AGENT = "karaoke-now/0.1 (local practice tool)"
DURATION_TOLERANCE_S = 3.0


def fetch_synced(
    artist: str | None,
    title: str | None,
    duration_s: float,
    album: str | None = None,
) -> str | None:
    if not artist or not title:
        return None
    headers = {"User-Agent": USER_AGENT}

    params = {"artist_name": artist, "track_name": title, "duration": round(duration_s)}
    if album:
        params["album_name"] = album
    r = requests.get(f"{API_BASE}/get", params=params, headers=headers, timeout=15)
    if r.status_code == 200:
        synced = r.json().get("syncedLyrics")
        if synced:
            return synced

    # Exact match failed: search, then take the closest duration match.
    r = requests.get(
        f"{API_BASE}/search",
        params={"artist_name": artist, "track_name": title},
        headers=headers,
        timeout=15,
    )
    if r.status_code != 200:
        return None
    return select_candidate(r.json(), duration_s)


def retrofit(bundle_dir: Path, artist: str | None = None, title: str | None = None) -> bool:
    """Fetch lyrics into an existing bundle, e.g. after fixing missing tags.

    Skips the expensive pipeline stages entirely. Artist/title overrides are
    persisted to meta.json on success so the library reflects the fixed tags.
    """
    bdir = Path(bundle_dir)
    meta_path = bdir / "meta.json"
    if not meta_path.exists():
        raise ValueError(f"no meta.json in {bdir}")
    doc = json.loads(meta_path.read_text())

    artist = artist or doc.get("artist")
    title = title or doc.get("title")
    lrc = fetch_synced(artist, title, float(doc.get("duration_s") or 0), doc.get("album"))
    if not lrc:
        return False

    (bdir / "lyrics.lrc").write_text(lrc)
    doc["artist"], doc["title"] = artist, title
    doc.setdefault("stages", {})["lyrics"] = "done"
    meta_path.write_text(json.dumps(doc, indent=2))
    return True


def select_candidate(results: list[dict] | None, duration_s: float) -> str | None:
    """Best synced-lyrics candidate within duration tolerance. Pure function."""
    best = None
    best_delta = DURATION_TOLERANCE_S + 1
    for item in results or []:
        synced = item.get("syncedLyrics")
        if not synced:
            continue
        delta = abs(float(item.get("duration") or 0) - duration_s)
        if delta <= DURATION_TOLERANCE_S and delta < best_delta:
            best, best_delta = synced, delta
    return best
