"""
Flashing-table tests for ``mavlink.safety.failsafe_param_map``.

The map is the table a human flashes onto the FC (docs/flashing.md), so a wrong
battery threshold is a hardware hazard rather than a failing assertion: too low
and the low/critical battery failsafe never fires before the pack is ruined.
These tests pin the per-cell derivation and the fail-safe degradation of a
nonsense cell count, so the table can never silently belong to another pack.
"""
from __future__ import annotations

from eis_companion.mavlink.safety import (
    CELL_CRT_VOLT,
    CELL_LOW_VOLT,
    DEFAULT_PACK_CELLS,
    failsafe_param_map,
)
from eis_companion.types import Limits


def test_battery_thresholds_default_to_the_bom_4s_pack():
    params = failsafe_param_map(Limits())
    assert DEFAULT_PACK_CELLS == 4
    assert params["BATT_LOW_VOLT"] == 14.0
    assert params["BATT_CRT_VOLT"] == 13.2


def test_battery_thresholds_track_the_cell_count():
    params = failsafe_param_map(Limits(), cell_count=3)
    assert params["BATT_LOW_VOLT"] == 10.5
    assert params["BATT_CRT_VOLT"] == 9.9


def test_every_supported_pack_stays_above_the_per_cell_floor():
    # The warning must always sit above the critical level, and both must stay
    # at a real per-cell voltage -- never a value a 4S pack reaches only when
    # it is already destroyed.
    for cells in range(1, 13):
        params = failsafe_param_map(Limits(), cell_count=cells)
        assert params["BATT_LOW_VOLT"] > params["BATT_CRT_VOLT"]
        assert params["BATT_LOW_VOLT"] == round(CELL_LOW_VOLT * cells, 2)
        assert params["BATT_CRT_VOLT"] == round(CELL_CRT_VOLT * cells, 2)


def test_nonsense_cell_count_degrades_to_the_documented_pack():
    for bad in (0, -3, 99, None, "4S"):
        params = failsafe_param_map(Limits(), cell_count=bad)  # type: ignore[arg-type]
        assert params["BATT_LOW_VOLT"] == round(CELL_LOW_VOLT * DEFAULT_PACK_CELLS, 2)
        assert params["BATT_CRT_VOLT"] == round(CELL_CRT_VOLT * DEFAULT_PACK_CELLS, 2)
