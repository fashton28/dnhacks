# ARGUS

ARGUS is a simulated autonomous site-monitoring platform for critical infrastructure.
An overhead imagery layer flags change at a facility, an LLM agent decides what to investigate, a deterministic safety layer admits or rejects the plan, and a PX4-flown drone inspects the site and reports to a human operator.

## Language

**Site**:
The fictional critical-infrastructure facility being monitored. A compact simulated world (a few hundred metres across) anchored at real-world coordinates so geofence and altitude math is real. Has a perimeter fence, protected areas, and no-fly zones.
_Avoid_: plant, facility (fine in prose, but the entity is the Site), world (the World is the simulator's rendering of the Site)

**Detection**:
A candidate change flagged by the wide-area layer: a georeferenced polygon, a confidence, and a change type. Unconfirmed. A Detection may never become an Incident.
_Avoid_: alert, anomaly, alarm

**Wide-area layer**:
The overhead-imagery stage that compares a before and an after top-down image of the Site and emits Detections. The images are overhead renders of the Site, before and after a Scenario runs.
_Avoid_: satellite layer (pitch language; the demo imagery is a simulated overhead pass), satellite view (see Overview)

**Triage Agent**:
The LLM that reads a Detection plus Site context and emits a MissionSpec. It states intent and judgment; it never computes waypoints.

**MissionSpec**:
The Triage Agent's intent for one Detection: objective, survey polygon, altitude ceiling, standoff distance, and rationale. Contains no waypoints.
_Avoid_: mission plan, plan

**FlightPlan**:
The deterministic expansion of a MissionSpec into waypoints with estimated duration and battery use. Produced by the Coverage Planner, never by the LLM.
_Avoid_: route (the drawn line on the map is the FlightPlan's route)

**Safety Validator**:
The deterministic, rule-based gate that turns a FlightPlan into a ValidationResult before dispatch, and clamps Manual Control commands at the same limits in flight. Contains no LLM. It is layer one; the Drone's own onboard geofence is the independent layer two.
_Avoid_: verifier, trust layer (pitch language for the same thing), guardrail

**ValidationResult**:
The Safety Validator's verdict on one FlightPlan: accept or reject, plus the named rules violated.

**Mission**:
One dispatched flight investigating one Detection, from accepted FlightPlan through landing. A Mission is flown by exactly one Drone.
_Avoid_: sortie, flight, job

**Observation**:
What the Drone captured and concluded at one point in a Mission: a frame plus the vision model's reading of it.
_Avoid_: snapshot, evidence (evidence is the stored frames an Observation references)

**Incident Report**:
The written outcome of a Mission for a human operator: a verdict of false alarm, log, or escalate, a narrative, and evidence references. Only an escalated Incident Report reaches a human as an incident.
_Avoid_: report, summary

**Operator**:
The human using the Console. Dispatches Missions, reads Incident Reports, and decides on escalations. The system never escalates without an Operator.

**Console**:
The web application the Operator uses. Contains the Overview, the World view, one Drone view per Drone, the detection queue, the validation panel, and Incident Reports.
_Avoid_: dashboard, UI

**Overview**:
The Console's top-down map of the Site showing every Drone in the Fleet, its track, Detections, geofences, and no-fly zones. Clicking a Drone opens its Drone view.
_Avoid_: satellite view, fleet view, map (map is the widget, Overview is the screen)

**World view**:
The Console's live 3D rendering of the Site with the Fleet and the current Scenario, drawn by the Renderer. For the audience and the Operator.
_Avoid_: simulator view, 3D view

**Drone view**:
The Console screen for one Drone: its live camera (the Renderer's camera at the Drone's pose and gimbal angle), telemetry, current Mission and agent reasoning, with the option to take Manual Control.
_Avoid_: drop-in, cockpit, FPV

**Renderer**:
The Three.js scene that draws the Site, the Fleet and the Scenario from the Hub's live state, and produces every camera frame: Drone views, evidence captures, and overhead images. Runs in the Console, or headless for unattended captures.
_Avoid_: simulator, engine, viewer

**Manual Control**:
The Operator flying one Drone directly from its Drone view with velocity commands. Pauses the Drone's Mission. The Safety Validator still applies: geofence, altitude ceiling, and no-fly zones are hard limits the Operator cannot cross. Ends with resume or abort of the Mission.
_Avoid_: teleop, override, full control (pitch language for Manual Control)

**Drone**:
One simulated quadcopter: an ArduPilot flight stack with its own physics, a home pad, battery state, and a gimballed camera drawn by the Renderer. Flies either a Mission or under Manual Control, never both. One of many in a Fleet.
_Avoid_: UAV, vehicle (vehicle is what a Drone might detect), SITL instance (implementation term)

**Bridge**:
The per-Drone process that translates between the Hub controller protocol and the Drone's MAVLink flight stack. The Hub cannot tell a bridged Drone from a fake Drone.
_Avoid_: adapter, driver

**Fleet**:
The set of Drones available at a Site. Its size is configured by the Operator, not fixed by the system.

**Scenario**:
A scripted change to the Site that creates something to detect: an intruder vehicle appears at the perimeter, a fence section opens, an object is left near a building. Scenarios are what the wide-area layer's after image differs by.
_Avoid_: test case, event, anomaly

**Scenario engine**:
The part of the Hub with authority over the Site itself: it runs Scenarios, holds the scene state every Renderer draws, requests overhead images, and resets the Site. It never flies a Drone.
_Avoid_: supervisor (ADR 0001 term), god mode, orchestrator

**Hub**:
The single backend process that connects Drones, the Triage Agent, the Safety Validator, the Console, and the audit log. Every command to a Drone passes through the Hub.
_Avoid_: server, backend, API (fine in code, but the entity is the Hub)
