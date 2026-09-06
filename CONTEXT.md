# ARGUS

ARGUS is a simulated autonomous site-monitoring platform for critical infrastructure.
An overhead imagery layer flags change at a facility, an LLM agent decides what to investigate and declares the envelope it will work inside, a deterministic safety layer admits or shrinks that envelope and re-checks every move, and an ArduPilot-flown drone inspects the site and reports to a human operator.

## Language

**Site**:
The fictional critical-infrastructure facility being monitored. A compact simulated world (a few hundred metres across) anchored at real-world coordinates so geofence and altitude math is real. Has a perimeter fence, protected areas, and no-fly zones.
_Avoid_: plant, facility (fine in prose, but the entity is the Site), world (the World is the simulator's rendering of the Site)

**Zone**:
A named polygon inside the Site with a security classification: protected area, service yard, exclusion zone, or open ground. Zones are declared in Site context, never inferred. The Triage Agent reads the Zone a Detection falls in; the Safety Validator reads exclusion zones as no-fly.
_Avoid_: region, sector, area (fine in prose, but the entity is the Zone)

**Site context**:
The static description of the Site that the Triage Agent reads alongside a Detection: the Zones, what is normally present in each, and the current maintenance schedule. Authored by hand, not generated. Without it, Scenarios 3 and 4 have no basis for a decision and triage degrades to restating the Detection.
_Avoid_: metadata, config, profile

**Detection**:
A candidate change flagged by the wide-area layer: a georeferenced polygon, a confidence, and a change type. Unconfirmed. A Detection may never become an Incident.
_Avoid_: alert, anomaly, alarm

**Wide-area layer**:
The overhead-imagery stage that compares a before and an after top-down image of the Site and emits Detections. The images are overhead renders of the Site, before and after a Scenario runs.
_Avoid_: satellite layer (pitch language; the demo imagery is a simulated overhead pass), satellite view (see Overview)

**Triage Agent**:
The LLM that reads a Detection plus Site context and emits a MissionSpec. It states intent and judgment; it never computes waypoints.

**Triage decision**:
The Triage Agent's first output for a Detection, made before any plan is requested: dispatch, log only, or ignore, with the Zone it reasoned from and a rationale.
A log-only or ignore decision ends the Detection in an Incident Report without a flight.
_Avoid_: pre-triage (implementation name for the same step), screening

**Envelope**:
What the Triage Agent declares before takeoff and flies inside for the whole Mission: a radius around the Detection, an altitude ceiling, a time budget, an objective.
The Hub expresses it as a MissionSpec and the Safety Validator checks its polygon against the Site limits before any motor spins.
A refused Envelope is shrunk deterministically and re-checked; the agent sees the rule that refused it.
_Avoid_: bounding box, area of operations

**Agent-flown Mission**:
A Mission in which the Triage Agent is in control of the Drone for the whole flight through tools (fly to, hold, look at, set camera, capture, return home, done) inside its Envelope.
Every fly-to passes the Safety Validator in real time; hard stops (step budget, time budget, battery reserve, Operator abort) end the flight and return the Drone home and are code, not prompt.
The earlier plan-based Mission, where the agent proposes a FlightPlan that the Hub flies, remains as the fallback mode.

**Hard stop**:
A condition that ends an Agent-flown Mission regardless of what the agent wants: step budget, time budget, battery reserve, or Operator abort.
The Drone returns home and the reason is published and audited.

**Inspection**:
What the Triage Agent does while a Drone holds at an on-station waypoint: a bounded sequence of Agent Actions (aim the camera, switch vision mode, zoom, capture, small repositions) ending in a summary and a threat assessment.
The approved FlightPlan is not changed by an Inspection; every reposition is checked by the Safety Validator and bounded to a small radius around the approved waypoint.

**Agent Action**:
One tool call the Triage Agent makes during an Inspection, with its arguments and result. Every Agent Action is published on the live feed and written to the audit log.
_Avoid_: step, command (a command is what the Hub sends to a Drone)

**Red-team case**:
A named adversarial input run against the full pipeline to show a refusal with the rule that produced it: an illegal first plan, a Detection carrying injected instructions, a change outside the flight envelope, a plan beyond endurance.

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
A scripted change to the Site that creates something to detect. Scenarios are what the wide-area layer's after image differs by. Exactly five are in scope; they are catalogued under "What we monitor" below, and a change not in that list is not in scope.
_Avoid_: test case, event, anomaly

**Scenario engine**:
The part of the Hub with authority over the Site itself: it runs Scenarios, holds the scene state every Renderer draws, requests overhead images, and resets the Site. It never flies a Drone.
_Avoid_: supervisor (ADR 0001 term), god mode, orchestrator

**Hub**:
The single backend process that connects Drones, the Triage Agent, the Safety Validator, the Console, and the audit log. Every command to a Drone passes through the Hub.
_Avoid_: server, backend, API (fine in code, but the entity is the Hub)

---

## What we monitor

Five Scenarios, and only these five. Each names what changes at the Site, what the wide-area layer should produce, what the correct outcome is, and why it earns a place in the set.

**1. `intruder_vehicle`**
A vehicle stops against the outer perimeter fence. A large contiguous change, well clear of the minimum-area threshold. Triage dispatches; the Incident Report escalates.
In the set because it is the largest and most legible change from directly overhead, and it is the demo opener.

**2. `unattended_object`**
A crate is left beside the reactor building, inside a protected area. A small change, close to the minimum-area threshold. Triage dispatches; the Incident Report escalates.
In the set because it exercises the area threshold, and because an unattended object inside a protected area is the canonical security concern at a Site like this.

**3. `unattended_object_benign`**
The same crate, in the service yard. The same object, the same change area, a different Zone. Triage dispatches at lower priority; the Incident Report logs rather than escalates.
In the set because it produces effectively the same Detection as Scenario 2 with the opposite outcome, and the only thing separating them is the Triage Agent reasoning about the Zone. Run 2 and 3 back to back in the demo: it is the clearest available proof that the judgment layer is doing work no rule could do.

**4. `authorized_activity`**
A marked maintenance vehicle parks in the service yard during a maintenance window declared in Site context. The wide-area layer detects it. Triage declines to dispatch.
In the set because it is the only Scenario where the correct action is to do nothing. It is where the false-positive rate comes from, and a monitoring system that cannot restrain itself is one an Operator switches off.

**5. `perimeter_opening`**
A named fence section is translated open. A thin change, and from directly above a fence is only a few pixels wide, so the opening must be paired with visible ground disturbance or it falls under the minimum area. Triage dispatches; the Incident Report escalates.
In the set because it is the hardest change to make legible from overhead. Build it last.

**6. `transformer_fire`**
A transformer bay in the switchyard catches fire: flames, a dark smoke column, scorched ground. From above the overhead pass sees a large new column and shadow. Triage dispatches at once; the Drone holds a standoff, confirms with the thermal camera (the bay saturates the sensor) and the Incident Report escalates to fire response and de-energizing the bay.
In the set because it is the operational anomaly a nuclear site actually plans for, and because the thermal camera is what turns a grey column into a decision.

**7. `steam_release`**
A relief vent on the auxiliary building roof lifts without notice: a white column that from above is indistinguishable from Scenario 6. Triage dispatches; the thermal camera reads the plume cool, water vapour, structure intact; the Incident Report logs an unplanned relief lift for maintenance and does not escalate.
In the set because it produces the same Detection as Scenario 6 with the opposite outcome, and the only thing separating them is a sensor choice the agent makes on station. Run 6 and 7 back to back in the demo.

### Build order

1, then 4, then 3, then 2, then 5. Scenario 1 unblocks the pipeline. Without 4 the eval numbers mean nothing. Without 3 the pitch loses its strongest moment.

### Overhead pairs must differ by more than the Scenario

Two renders of an unchanged Site are pixel-identical, so a detector run against clean pairs scores 100% precision and 100% recall by construction, and a number that cannot fall is not a measurement. Every overhead pass therefore varies the sun angle, applies slight camera jitter, saves through JPEG compression, and allows benign motion such as Drones repositioned on their pads. This is what makes the minimum-area and confidence thresholds tunable parameters rather than decoration.

### Out of scope

Identifying a person, reading a plate, counting occupants, or inferring intent. The wide-area layer localises change, the Drone's Observations describe what is there, and the Operator decides what it means.
