# 0001. Webots as the simulator, native flight controller instead of PX4

Status: **Superseded** by `docs/ADR-hackathon.md` D8 (Docker ArduPilot SITL) and
D9 (Komati site). Retained as the record of why Webots was chosen and what that
choice would have cost.

**What actually happened.** The integrated platform under `platform/` flies
ArduPilot SITL in Docker; no Webots code was ever written. Both consequences this
ADR accepted were therefore reversed: the "real flight code is flying" claim is
available again, and ArduPilot's native polygon fence returns as an independent
firmware-level backstop beneath the ground MissionVerifier and the companion
watchdogs (see `docs/FAILURE_MODES.md`).

The design this ADR belonged to — `ARCHITECTURE.md`, `CONTEXT.md`, the root
`contracts/` package, and `docs/specs/0001` — was removed once the platform
retrofit landed. Recover any of it from history; no commits were rewritten.

## Context

The original proposal (ARCHITECTURE.md) built on PX4 SITL with Gazebo Harmonic so the pitch could claim the real flight code was flying.
Facts that emerged while planning:

- The whole team is on Apple Silicon Macs.
  PX4 marks Gazebo on Apple Silicon as unstable, and multi-vehicle PX4 SITL is Linux-only.
  Rendered camera feeds for several drones would need a Linux GPU VM.
- The deadline is noon, about 24 hours from the recorded start.
- The demo needs a Fleet of Drones visible on an Overview, live per-Drone camera views, Manual Control from the browser, and a live 3D World view.
- Webots R2025a runs natively on Apple Silicon, supports many robots in one world, ships a DJI Mavic 2 Pro with camera, gimbal, GPS and IMU and a Python waypoint controller, has an asset library of buildings, roads, vehicles and pedestrians, and streams its 3D scene to a browser.
- No PX4 to Webots bridge exists.
  ArduPilot has an official Webots bridge, but it requires an ArduPilot build per Mac on an undocumented platform.

## Decision

Use Webots as the simulator, running locally on every teammate's Mac.
Fly the Drones with a native Python flight controller extended from the Webots Mavic sample, exposed behind a MAVLink-shaped `Drone` interface (positions as lat/lon/alt, velocities in NED).
ArduPilot SITL through the official Webots bridge is a stretch goal behind the same interface, not part of the plan.

## Consequences

- Every teammate runs the full simulation locally with GPU rendering, with no Linux VM to provision or share.
- The pitch can no longer claim "the real flight code is flying".
  It claims instead that the planner, Safety Validator and tool boundary are flight-stack agnostic and target MAVLink for hardware.
  Say this out loud rather than letting a judge discover it.
- PX4's onboard geofence is gone as an independent second safety layer.
  Defense in depth must come from the Safety Validator gating both dispatch and Manual Control, plus hard limits inside the flight controller itself.
- The "one process" constraint becomes one Hub process plus one extern controller process per Drone and one Supervisor.
- The wide-area layer uses overhead renders of the Webots Site instead of real satellite or aerial imagery.
