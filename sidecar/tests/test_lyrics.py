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
