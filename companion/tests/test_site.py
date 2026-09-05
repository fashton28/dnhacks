"""
Site-model loader tests (docs/SITE_CONTRACT.md).

Proves:
  * site/site.stub.json parses into the exact dataclass shapes (home,
    perimeter as (lat, lon) tuples in order, NFZ polygons + ceilings,
    alt band, staging points with truth labels),
  * path resolution honours explicit arg > EIS_SITE_FILE > default,
    anchored at the repo root,
  * schema violations raise ValueError naming the offending field
    (never a silent partial parse).

Pure stdlib -- no hardware, no network.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from eis_companion.site import (
    DEFAULT_SITE_REL,
    SITE_FILE_ENV,
    Site,
    load_site,
    load_site_from_env,
    resolve_site_path,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
STUB = REPO_ROOT / "site" / "site.stub.json"


def _valid_raw() -> dict:
    """A minimal valid site dict for mutation-based validation tests."""
    return {
        "home": {"lat": -35.363261, "lon": 149.16523, "alt_m": 584.0},
        "perimeter": [
            [-35.360761, 149.16223],
            [-35.360761, 149.16823],
            [-35.365761, 149.16823],
        ],
        "nfz": [],
        "alt_band_m": {"min": 20, "max": 60},
        "staging": [],
    }


def _write(tmp_path: Path, raw: dict) -> Path:
    p = tmp_path / "site.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    return p


# --------------------------------------------------------------------------
# Parsing the committed stub
# --------------------------------------------------------------------------
def test_stub_parses_exactly():
    site = load_site(STUB)
    assert isinstance(site, Site)
    assert site.source_path == str(STUB)

    assert site.home.lat == pytest.approx(-35.363261)
    assert site.home.lon == pytest.approx(149.16523)
    assert site.home.alt_m == pytest.approx(584.0)

    # Perimeter: order preserved, [lat, lon] -> (lat, lon).
    assert site.perimeter == [
        (-35.360761, 149.16223),
        (-35.360761, 149.16823),
        (-35.365761, 149.16823),
        (-35.365761, 149.16223),
    ]

    assert len(site.nfz) == 1
    zone = site.nfz[0]
    assert zone.name == "switchyard"
    assert zone.ceiling_m == pytest.approx(120.0)
    assert zone.polygon == [
        (-35.3616, 149.1662),
        (-35.3616, 149.1674),
        (-35.3624, 149.1674),
        (-35.3624, 149.1662),
    ]

    assert site.alt_band.min_m == pytest.approx(20.0)
    assert site.alt_band.max_m == pytest.approx(60.0)

    assert [s.id for s in site.staging] == ["stage-a", "stage-b"]
    a, b = site.staging
    assert (a.lat, a.lon) == (pytest.approx(-35.3648), pytest.approx(149.1669))
    assert a.image == "site/staging/stage-a.png"
    assert a.truth == "vehicle"
    assert b.truth == "false_alarm"


def test_nfz_and_staging_default_empty(tmp_path):
    raw = _valid_raw()
    del raw["nfz"]
    del raw["staging"]
    site = load_site(_write(tmp_path, raw))
    assert site.nfz == []
    assert site.staging == []


# --------------------------------------------------------------------------
# Path resolution: explicit > EIS_SITE_FILE > default, repo-root anchored
# --------------------------------------------------------------------------
def test_resolve_explicit_absolute_wins(monkeypatch, tmp_path):
    monkeypatch.setenv(SITE_FILE_ENV, "somewhere/else.json")
    p = _write(tmp_path, _valid_raw())
    assert resolve_site_path(str(p)) == p


def test_resolve_env_var_relative_to_repo_root(monkeypatch):
    monkeypatch.setenv(SITE_FILE_ENV, "site/site.stub.json")
    assert resolve_site_path().resolve() == STUB


def test_resolve_default_is_site_json_at_repo_root(monkeypatch):
    monkeypatch.delenv(SITE_FILE_ENV, raising=False)
    resolved = resolve_site_path()
    assert resolved.resolve() == (REPO_ROOT / DEFAULT_SITE_REL).resolve()


def test_load_site_from_env_uses_stub(monkeypatch):
    monkeypatch.setenv(SITE_FILE_ENV, "site/site.stub.json")
    site = load_site_from_env()
    assert site.home.lat == pytest.approx(-35.363261)
    assert len(site.perimeter) == 4


def test_missing_file_raises_file_not_found(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_site(tmp_path / "nope.json")


# --------------------------------------------------------------------------
# Validation: every schema violation is a loud ValueError
# --------------------------------------------------------------------------
def test_missing_home_rejected(tmp_path):
    raw = _valid_raw()
    del raw["home"]
    with pytest.raises(ValueError, match="home"):
        load_site(_write(tmp_path, raw))


def test_home_lat_out_of_range_rejected(tmp_path):
    raw = _valid_raw()
    raw["home"]["lat"] = 91.0
    with pytest.raises(ValueError, match="home.lat"):
        load_site(_write(tmp_path, raw))


def test_perimeter_too_few_vertices_rejected(tmp_path):
    raw = _valid_raw()
    raw["perimeter"] = raw["perimeter"][:2]
    with pytest.raises(ValueError, match="perimeter"):
        load_site(_write(tmp_path, raw))


def test_perimeter_bad_pair_rejected(tmp_path):
    raw = _valid_raw()
    raw["perimeter"][1] = [-35.36]  # not a [lat, lon] pair
    with pytest.raises(ValueError, match=r"perimeter\[1\]"):
        load_site(_write(tmp_path, raw))


def test_alt_band_inverted_rejected(tmp_path):
    raw = _valid_raw()
    raw["alt_band_m"] = {"min": 60, "max": 20}
    with pytest.raises(ValueError, match="alt_band_m"):
        load_site(_write(tmp_path, raw))


def test_alt_band_negative_min_rejected(tmp_path):
    raw = _valid_raw()
    raw["alt_band_m"] = {"min": -1, "max": 20}
    with pytest.raises(ValueError, match="alt_band_m.min"):
        load_site(_write(tmp_path, raw))


def test_nfz_polygon_required(tmp_path):
    raw = _valid_raw()
    raw["nfz"] = [{"name": "x", "ceiling_m": 10}]  # no polygon
    with pytest.raises(ValueError, match=r"nfz\[0\].polygon"):
        load_site(_write(tmp_path, raw))


def test_staging_bad_truth_rejected(tmp_path):
    raw = _valid_raw()
    raw["staging"] = [
        {"id": "s1", "lat": 0.0, "lon": 0.0, "image": "x.png", "truth": "ufo"},
    ]
    with pytest.raises(ValueError, match=r"staging\[0\].truth"):
        load_site(_write(tmp_path, raw))


def test_staging_duplicate_id_rejected(tmp_path):
    raw = _valid_raw()
    point = {"id": "s1", "lat": 0.0, "lon": 0.0, "image": "x.png", "truth": "vehicle"}
    raw["staging"] = [point, dict(point)]
    with pytest.raises(ValueError, match=r"staging\[1\].id"):
        load_site(_write(tmp_path, raw))


def test_non_finite_number_rejected(tmp_path):
    raw = _valid_raw()
    raw["home"]["alt_m"] = float("nan")
    p = tmp_path / "site.json"
    # json.dumps would refuse NaN by default in strict readers; write it raw.
    p.write_text(json.dumps(raw), encoding="utf-8")  # emits NaN literal
    with pytest.raises(ValueError, match="home.alt_m"):
        load_site(p)


def test_invalid_json_rejected(tmp_path):
    p = tmp_path / "site.json"
    p.write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON"):
        load_site(p)
