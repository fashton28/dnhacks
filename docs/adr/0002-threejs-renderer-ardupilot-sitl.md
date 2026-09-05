# 0002. Three.js as the environment, ArduPilot SITL as the flight stack

Date: 2026-09-05
Status: Accepted. Supersedes 0001.

## Context

ADR 0001 chose Webots for physics, rendering, and scenario scripting.
It worked: the Site loaded, three Drones ran in lockstep, and a native flight controller was being tuned.
Two things changed the decision:

- Photorealism of the Drone view and the environment was judged one of the most important properties of the project, and Webots rendering cannot get there.
- Full programmatic control over the environment and over Scenarios was judged more valuable than a ready-made simulator.
  A renderer written by the team in Three.js gives that control; a simulator's asset library and world format do not.

Facts that shaped the replacement:

- ArduPilot Copter SITL ships its own multicopter physics.
  Unlike PX4, it needs no external simulator to fly, so a renderer that only draws the vehicle state is sufficient.
- ArduPilot exposes a real onboard geofence (altitude, circle, polygon) and failsafes that the agent cannot reach.
  That restores the independent second safety layer that Webots removed.
- ArduPilot SITL builds natively on Apple Silicon with known rough edges (a historical floating-point exception crash in ArduPlane; Copter is the vehicle we build).
  A Docker image is the fallback.
- Three.js renders PBR materials, HDRI lighting, orthophoto ground, and GLTF assets in the browser, and can capture any camera to a JPEG.
  Poly Haven and OpenAerialMap provide CC0 and openly licensed assets.
- PX4 was considered and rejected again: its SITL requires an external simulator providing sensors, which is exactly the component we would have to write.

## Decision

- **Flight**: one ArduPilot Copter SITL process per Drone, own physics, real onboard fence parameters set from the Site geometry.
- **Bridge**: a Python MAVLink bridge per Drone that speaks the Hub controller protocol unchanged.
  The Hub cannot tell a bridged ArduPilot Drone from the fake Drone.
- **Environment**: a Three.js scene in the Console built from a generated Site description (the same numbers that produce the Site GeoJSON).
  It renders the World view, and a per-Drone camera rendered at the Drone's pose is the Drone view.
- **Frames**: the renderer sends JPEG frames to the Hub under a `renderer` role, both streamed for the selected Drone view and on demand for evidence captures.
  A headless browser can run the same renderer for unattended captures.
- **Scenarios**: a scene state owned by the Hub (props, fence gaps) that every renderer draws.
  Overhead before and after images are top-down captures from the renderer.
  The Supervisor role from ADR 0001 becomes the Hub's scenario engine.

## Consequences

- The pitch regains "the real flight code is flying" with ArduPilot, and gains a real onboard geofence as defense in depth.
- The team owns every pixel and every Scenario, at the cost of building the scene, assets, and camera pipeline in Three.js.
- Camera frames depend on a browser (or a headless one) being connected; the smoke test runs a headless renderer.
- The Webots world, controllers, and tooling are removed.
  The contracts, Hub, fake Drone, and tests carry over unchanged.
- ArduPilot must build on every teammate's Mac; the install guide and a Docker fallback are part of the first ticket.
