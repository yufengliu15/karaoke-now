from karaoke_sidecar import bundle


def test_guess_from_filename_artist_title():
    assert bundle.guess_from_filename("Daft Punk - Get Lucky") == ("Daft Punk", "Get Lucky")


def test_guess_from_filename_keeps_extra_hyphens_in_title():
    assert bundle.guess_from_filename("Foo - Bar - Baz") == ("Foo", "Bar - Baz")


def test_guess_from_filename_no_artist():
    assert bundle.guess_from_filename("mysong") == (None, "mysong")


def test_song_id_stable(wav_factory):
    p = wav_factory("a.wav")
    assert bundle.song_id(p) == bundle.song_id(p)
    assert len(bundle.song_id(p)) == 16


def test_probe_wav_uses_filename_guess(wav_factory):
    p = wav_factory("Foo Bar - Baz Song.wav", seconds=2.0)
    meta = bundle.probe(p)
    assert meta.artist == "Foo Bar"
    assert meta.title == "Baz Song"
    assert 1.9 < meta.duration_s < 2.1


def test_meta_roundtrip_and_complete(wav_factory, tmp_path):
    p = wav_factory("x.wav")
    meta = bundle.probe(p)
    bdir = bundle.bundle_dir(tmp_path / "songs", meta.id)

    assert not bundle.is_complete(bundle.read_meta(bdir))

    bundle.write_meta(bdir, meta, {"separate": "done", "contour": "done", "lyrics": "none"})
    doc = bundle.read_meta(bdir)
    assert bundle.is_complete(doc)
    assert doc["title"] == "x"
    assert doc["bundle_version"] == bundle.BUNDLE_VERSION


def test_incomplete_without_contour(wav_factory, tmp_path):
    p = wav_factory("y.wav")
    meta = bundle.probe(p)
    bdir = bundle.bundle_dir(tmp_path / "songs", meta.id)
    bundle.write_meta(bdir, meta, {"separate": "done"})
    assert not bundle.is_complete(bundle.read_meta(bdir))
