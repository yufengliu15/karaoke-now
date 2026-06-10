from karaoke_sidecar import lyrics


def test_select_candidate_prefers_closest_duration():
    results = [
        {"syncedLyrics": "[00:01.00] far", "duration": 250},
        {"syncedLyrics": "[00:01.00] near", "duration": 201},
        {"syncedLyrics": None, "duration": 200},
    ]
    assert lyrics.select_candidate(results, 200.0) == "[00:01.00] near"


def test_select_candidate_skips_unsynced_even_if_exact():
    results = [{"syncedLyrics": None, "duration": 200}]
    assert lyrics.select_candidate(results, 200.0) is None


def test_select_candidate_rejects_out_of_tolerance():
    results = [{"syncedLyrics": "x", "duration": 230}]
    assert lyrics.select_candidate(results, 200.0) is None


def test_select_candidate_empty_or_none():
    assert lyrics.select_candidate([], 200.0) is None
    assert lyrics.select_candidate(None, 200.0) is None


def test_fetch_requires_artist_and_title():
    assert lyrics.fetch_synced(None, "Title", 200.0) is None
    assert lyrics.fetch_synced("Artist", None, 200.0) is None


def _bundle_with_meta(tmp_path, **overrides):
    import json

    bdir = tmp_path / "songs" / "abc123"
    bdir.mkdir(parents=True)
    doc = {
        "bundle_version": 1,
        "id": "abc123",
        "source_path": "/x.mp3",
        "title": "I Want You Back",
        "artist": None,
        "album": None,
        "duration_s": 176.4,
        "stages": {"separate": "done", "contour": "done", "lyrics": "none"},
        "processed_at": "2026-06-10T11:20:46",
    }
    doc.update(overrides)
    (bdir / "meta.json").write_text(json.dumps(doc))
    return bdir


def test_retrofit_writes_lrc_and_updates_meta(tmp_path, monkeypatch):
    import json

    bdir = _bundle_with_meta(tmp_path)
    seen = {}

    def fake_fetch(artist, title, duration_s, album=None):
        seen.update(artist=artist, title=title, duration_s=duration_s)
        return "[00:01.00] hi"

    monkeypatch.setattr(lyrics, "fetch_synced", fake_fetch)
    found = lyrics.retrofit(bdir, artist="The Jackson 5", title=None)

    assert found is True
    assert (bdir / "lyrics.lrc").read_text() == "[00:01.00] hi"
    assert seen == {"artist": "The Jackson 5", "title": "I Want You Back", "duration_s": 176.4}
    doc = json.loads((bdir / "meta.json").read_text())
    assert doc["stages"]["lyrics"] == "done"
    assert doc["artist"] == "The Jackson 5"  # override persisted for the library view
    assert doc["title"] == "I Want You Back"


def test_retrofit_no_match_leaves_bundle_unchanged(tmp_path, monkeypatch):
    import json

    bdir = _bundle_with_meta(tmp_path)
    monkeypatch.setattr(lyrics, "fetch_synced", lambda *a, **k: None)
    found = lyrics.retrofit(bdir, artist="Nobody", title=None)

    assert found is False
    assert not (bdir / "lyrics.lrc").exists()
    doc = json.loads((bdir / "meta.json").read_text())
    assert doc["stages"]["lyrics"] == "none"
    assert doc["artist"] is None  # failed lookup should not rewrite tags


def test_retrofit_requires_meta(tmp_path):
    import pytest

    bdir = tmp_path / "songs" / "nometa"
    bdir.mkdir(parents=True)
    with pytest.raises(ValueError):
        lyrics.retrofit(bdir, artist="X", title="Y")
