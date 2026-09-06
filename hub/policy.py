"""Autonomy policy: how much ARGUS may do on its own, and the two budgets it can never exceed.

manual      today: a Detection waits for an Operator to dispatch it.
supervised  a triage decision to dispatch executes itself after a veto window during which the dashboard shows the
            decision and a Hold button.
autonomous  no window; the Operator is informed and can abort at any time.

The Safety Validator, the envelope, the hard stops and the onboard fence are untouched by any of this: the policy
decides when to act, never what checks the action.
"""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from enum import StrEnum


class AutonomyMode(StrEnum):
    manual = "manual"
    supervised = "supervised"
    autonomous = "autonomous"


@dataclass
class AutonomyPolicy:
    mode: AutonomyMode = AutonomyMode.supervised
    veto_window_s: float = 15.0
    max_concurrent_flights: int = 1
    asset_cooldown_s: float = 600.0

    @classmethod
    def from_env(cls) -> AutonomyPolicy:
        return cls(
            mode=AutonomyMode(os.environ.get("ARGUS_AUTONOMY_MODE", "autonomous")),
            veto_window_s=float(os.environ.get("ARGUS_VETO_WINDOW_S", "15")),
            max_concurrent_flights=int(os.environ.get("ARGUS_MAX_CONCURRENT_FLIGHTS", "1")),
            asset_cooldown_s=float(os.environ.get("ARGUS_ASSET_COOLDOWN_S", "600")),
        )

    @property
    def window_s(self) -> float:
        """The veto window that applies right now: none when autonomous."""
        return 0.0 if self.mode == AutonomyMode.autonomous else self.veto_window_s

    def as_dict(self) -> dict:
        d = asdict(self)
        d["mode"] = self.mode.value
        return d
