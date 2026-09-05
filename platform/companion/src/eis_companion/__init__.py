"""
============================================================================
Drone Safety Platform -- COMPANION software (Jetson)  ::  eis_companion
----------------------------------------------------------------------------
Top-level package for the autonomous person-following drone's *companion*
software that runs on the NVIDIA Jetson Orin Nano:

    camera -> person detection -> single-target tracking -> visual-servoing
    guidance -> MAVLink GUIDED setpoints to the ArduPilot FC, plus a MAVLink
    bridge, a low-latency video stream, and a control WebSocket API to the
    Windows ground station.

Sub-packages
  types        in-process dataclasses (VehicleState / VelocitySetpoint / Limits)
  config       load + validate YAML config + env overrides -> typed AppConfig
  control      pure-logic core: pid / distance / tracker / guidance / manual
  mavlink      FC link (Vehicle) + pure-logic SafetyManager
  vision       capture / person detection / sim target source / TRT export
  api          control WebSocket server (the shared contract)
  stream       video stream (mediamtx + GStreamer, RTSP/WebRTC)
  app          the asyncio orchestrator + CLI entry (python -m eis_companion.app)

SAFETY-FIRST (PRD 11): standoff is a hard limit, every output is clamped to
``Limits``, the manual + ground-link watchdogs zero-and-hold on loss, and
emergencyStop/disarm override everything. The whole system is SITL-first --
nothing here requires hardware to run in simulation.
============================================================================
"""
from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
