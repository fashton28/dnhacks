# Concept of operations — Komati Power Station

Runtime paths in this document are relative to [`platform/`](..), this file's
parent directory.

How the system is operated, by whom, under what authority, and what happens when
the humans in the loop are not there. Adversaries and defence layers are in
[`docs/THREAT_MODEL.md`](THREAT_MODEL.md); per-failure responses and their
required assertions are in [`docs/FAILURE_MODES.md`](FAILURE_MODES.md).

The modelled site is **Komati Power Station, Mpumalanga** — an Eskom station
retired from generation in 2022, designated critical infrastructure, with a
switchyard that remains part of the grid. **Operation is demonstrated in
simulation only.** Nothing here has been flown at Komati and no Eskom system is
connected to.

---

## 1. Roles

Three roles, three different authorities. No role can acquire another's.

### Operator

At the ground station, in front of the five-panel console (map, task/plan,
verifier, envelope/status, report).

- Approves or declines every dispatch in attended mode; an approval is scoped to
  one task and **expires**.
- Reads reports and decides the verdict that leaves the system: log, or escalate.
- May take manual control at any moment. **Manual engage preempts everything**;
  disengage returns the vehicle to `hold`, never to whatever it was doing before.
- May enter or leave unattended mode only by issuing a **signed command**, and
  connecting an operator session **auto-reverts** the system to attended.
- Cannot relax a limit. Standoff floors, altitude bands, NFZ buffers, geofence
  margins and speed caps are re-asserted after any configuration is loaded and
  are re-clamped again on the vehicle. Dragging a target into the switchyard NFZ
  produces a verifier refusal, not a flight.

The operator is a security operator, not a pilot: the skill required is reading a
plan, a corridor and a report, plus the manual-control competency needed to take
the aircraft and put it in a hold.

### Security response team

The humans who physically go and look. They are the **only** responders: the
system produces evidence and a location, they decide and act.

- Receive escalations from the control room, never directly from the autonomy.
- Are never given an instruction by the system — a report says what was observed
  and where, and nothing about what to do about it.
- Are not tracked, followed or filmed by the vehicle. Once a response is under
  way, the sortie ends (`rtl`) rather than overflying responders.

### Control room

The plant/regional security control room that owns the escalation once it leaves
the ground station: it holds the roster, contacts the response team, and records
the disposition.

- Is the destination of every escalation in unattended mode and the second
  destination in attended mode.
- Owns the decision to call external parties (SAPS, Eskom incident management,
  emergency services). **The system never contacts anyone outside the site
  automatically.**

---

## 2. Modes

### Attended (default)

An operator session is connected and has an unexpired approval authority.

| | |
|---|---|
| Dispatch | Operator approves each task before it flies |
| Cue handling | Every valid cue is triaged and shown; nothing flies unapproved |
| Envelope | Full site envelope: 20–80 m band intersected with the profile band, inspect and survey profiles, buffered NFZs, operational geofence |
| Sorties | Bounded by battery reserve, the 480 s sortie cap, and wind limits |
| Escalation | Operator first; control room second |
| Manual | Available at all times; preempts all automation |

### Unattended

No operator session, or an operator session that has gone quiet. Entered **only**
by a signed command, and left automatically the moment an operator connects.
Unattended mode is deliberately much smaller than attended mode — it exists so a
cue at 02:00 produces evidence, not so the system runs the site.

**`UNATTENDED_ENVELOPE`**

| Constraint | Value | Why |
|---|---|---|
| Area | Inside the perimeter only | Nothing may leave the site without a human watching |
| Profiles | `inspect` only | Survey is a longer, wider-tolerance pattern that deserves supervision |
| Altitude | 30–50 m AGL | A subset of the 20–80 m site band, high enough to clear structures and clutter, low enough for useful RGB/thermal, and away from both band edges so the monitor's band check has margin |
| Orbit | One lap | Bounded, predictable, no adaptive loitering |
| Hold | ≤ 15 s | Matches the deterministic planner's only hold case (`fence_gap`) |
| Sortie rate | ≤ 2 per hour | Caps the damage from cue flooding and preserves battery for a real event |
| No dispatch when | `navSource != gps` | A degraded nav source blocks dispatch rather than degrading it |
| | RF interference present | GNSS integrity is unverifiable |
| | Hostile drone detected | Airspace is yielded, not contested |
| | Night without healthy thermal | A night mission with no thermal rail produces no useful observation |
| | Wind > ½ the attended limit (i.e. > 6 m/s of the 12 m/s limit) | Halved because there is nobody to take manual control |
| Entry | Signed command only | A compromised ground station cannot mint one |
| Exit | Automatic on operator connect | The safe direction is always toward supervision |

Anything a cue asks for that falls outside this envelope is **refused**, and the
refusal **escalates** — an unattended request the system declined is exactly the
thing a human should see.

---

## 3. Escalation chain

Timings are from the moment a report with verdict `escalate` is written, or from
the moment an unattended refusal is raised.

| Step | When | Destination | Channel | If no acknowledgement |
|---|---|---|---|---|
| 1 | T+0 | Operator console (attended) | In-console alert, persistent banner | after 60 s → step 2 |
| 1′ | T+0 | Control room (unattended) | Primary escalation channel | after 30 s → step 2 |
| 2 | T+60 s / T+30 s | Control room duty desk | Secondary channel (SMS/chat stub) | after 2 min → step 3 |
| 3 | T+3 min | Site security supervisor | Tertiary contact | after 5 min → step 4 |
| 4 | T+8 min | No further human destination | — | `escalation_undelivered` health event, local outbox retains the incident, no automatic external contact |

The escalation adapter is a channel abstraction: the scripted channel writes to
the audit log and a **local outbox**, and email/SMS/chat are stubs behind the same
interface. Delivery is retried per channel; exhausted retries produce a
`healthEvent` of `escalation_undelivered` rather than a silent drop. **Nothing on
the demo or test path blocks on the network** — an unreachable channel degrades
to the outbox and the audit log.

Acknowledgement means a human recorded receipt. It does not mean the incident is
resolved, and the chain does not restart on acknowledgement.

### When nobody answers

This is the case the design cares about most, because it is where an autonomous
system is tempted to do something clever. It does not.

1. **The aircraft does not wait for anyone.** The sortie is bounded by the plan's
   time budget, `min(range time, 480 s sortie cap)`, and by the battery reserve.
   When either is reached the vehicle flies `rtl` and lands, whether or not the
   escalation was ever read.
2. **The cue is not re-flown.** An unacknowledged escalation does not trigger
   another unattended sortie against the same cue; the 2-per-hour cap stands
   regardless.
3. **Nothing external is contacted.** No automated call to SAPS, to emergency
   services, or to anyone off site. The system's last act is an
   `escalation_undelivered` health event and a retained, hash-chained record.
4. **Further unattended dispatch is refused** while an escalation remains
   undelivered, and that refusal is itself recorded. The system gets quieter, not
   busier, when the humans are absent.
5. **No interdiction becomes available** because no one answered. There is no
   escalation ladder that ends in force; see
   [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) § "Out of scope".

---

## 4. Evidence, retention and privacy

### What is captured

Drone RGB and thermal frames for the observed cue location, LiDAR-derived
geometry, the cue-time fixed-camera frame that started it, the plan, the
verification result, the monitor trace, and the report — all bound to one
`vehicleId` and one mission record, in an append-only hash-chained audit log.

### No-image zones

Polygons in which capture is suppressed and outside which the gimbal is not
pointed. They are site configuration, not a model decision, and the planner
treats them as it treats NFZs: routes avoid them, orbits shrink to clear them, and
a task that can only be satisfied from inside one is **infeasible**, not
best-effort.

Minimum set for a site like Komati:

- The public road and rail reserve adjacent to the perimeter, and land beyond the
  perimeter generally — the site is observed, its neighbours are not.
- Neighbouring residential and farm land, including the settlements around the
  station.
- Contractor accommodation, offices, ablutions, change houses and any staff
  welfare area inside the perimeter.
- Any zone the site owner adds. The list is additive and never narrowed by the
  system.

Capture suppression is at the point of capture, so a suppressed frame does not
exist to be retained, leaked, or asked for later.

### Retention

| Class | Retention | Notes |
|---|---|---|
| Non-incident evidence (verdict `false_alarm` or `log`) | 30 days, then destroyed | The overwhelming majority of sorties |
| Evidence attached to an escalated incident | 12 months, or until the incident is formally closed if longer | Held because a human decided it matters |
| Hash-chained audit log (no imagery) | 12 months minimum | The record that makes suppression detectable is the one you keep longest |
| Cue-time fixed-camera frames | Same class as the sortie they triggered | Provenance travels with the evidence |

Retention periods are defaults for the deploying organisation to set against its
own policy and South African data-protection law (POPIA); the system's obligation
is that a period exists, is enforced by deletion, and is recorded.

### Privacy commitments

- **No identification of individuals**: no facial recognition, no gait analysis,
  no plate reading, no matching against any personnel or watchlist database. A
  detection is "a person", never "which person".
- **Not a staff-monitoring tool.** Routine patrol of occupied work areas is not a
  supported mode; sorties are cue-driven and bounded.
- Access to retained evidence is by named role, and every access is an audit
  entry.
- Evidence leaves the site only by a human decision, never automatically.

---

## 5. Legal constraints

Stated as constraints on deployment, not as legal advice; each needs confirmation
with the regulator and the site owner before any flight.

### Site status

Eskom generation sites, Komati included, were declared National Key Points under
the National Key Points Act and carried into the **Critical Infrastructure
Protection Act (Act 8 of 2019)** regime. Consequences that bind this system:

- Site security measures, including any aerial surveillance, are subject to the
  infrastructure administrator's approval and to the site's own security plan.
- There are restrictions on photographing and publishing information about
  declared critical infrastructure. Site geometry used here is a **deterministic
  stub**, not a survey, and imagery on the demo path is generated placeholder
  material explicitly labelled `image_kind: scripted_placeholder`.
- Evidence handling, retention and disclosure follow the site owner's rules, not
  this system's defaults, wherever the two differ.

**Everything demonstrated is simulated.** No approval has been sought because
nothing has been flown.

### Aviation

Any real flight is a South African RPAS operation under the Civil Aviation
Regulations administered by SACAA:

- **Part 101** governs RPAS. Non-private operation — which security work for a
  site owner is — requires a **Remote Pilot Licence (RPL)** for the pilot and an
  **RPAS Operator Certificate (ROC)** plus an air services licence for the
  operator, together with an approved operations manual naming this concept of
  operations.
- **Default limits** apply unless specifically approved: within visual line of
  sight, by day, below 400 ft (≈120 m) AGL, and not within 50 m of persons,
  property or structures without permission. Our 20–80 m band sits inside the
  altitude limit; the 50 m lateral rule is why every observation is standoff
  observation with permission from the site owner for the site itself.
- **BVLOS**, **night** and **operation over persons** each require specific
  approval. The unattended envelope in §2 is a system-level restriction that does
  **not** by itself satisfy a BVLOS approval; unattended operation would need one.
- Airspace coordination around the site (and any temporary restriction) is the
  operator's responsibility before flight.

### Constraints inherited from the platform

- **ArduPilot GUIDED only.** Guidance commands body-frame velocity setpoints; the
  firmware does the stabilisation; the RC transmitter retains override priority.
- **The onboard fence** is loaded from the same site geometry as the ground
  verifier and is not reachable from the ground stack or the LLM.
- **The SDR and RF rails are receive-only by construction.** Transmitting on GNSS
  or control bands is illegal, and there is no code path that could.

---

## 6. Honest deployability statement

What is true, stated plainly, so nobody has to infer it from a demo.

**Unchanged and real.** The flight-control firmware is stock ArduPilot with no
modification. Guidance runs in GUIDED mode over standard MAVLink setpoints. The
onboard geofence and failsafes are the firmware's own, configured from the site
geometry. Nothing in this project patches, forks or bypasses the autopilot, and
the final backstop on any flight is code we did not write and cannot reach.

**Validated in simulation.** Guidance, the deterministic planner and verifier, the
in-flight monitor, the unattended envelope, the sensing rails and the failure
gauntlet are exercised against ArduCopter SITL, scripted rails and fixtures. The
numbers that back any claim are in [`docs/NUMBERS.md`](NUMBERS.md); a claim
without a row there is not a claim.

**Simulated, and named as such.** Site geometry is a plausible deterministic stub,
not a survey of Komati. Staged imagery is generated placeholder material, not real
optical, thermal, Sentinel-2 or SAR capture. The renderer's pixels are rendered,
not sensed. Detection performance figures from scripted fixtures measure the
plumbing, not field performance.

**Not yet flown.** Between this system and a Komati deployment sits a flight-test
campaign that has not happened: airframe and payload qualification; fence,
failsafe and RTL behaviour verified in the air; corridor tolerances and monitor
thresholds tuned against real wind and real GNSS multipath around large steel
structures; thermal and LiDAR rails characterised at night and in Highveld
conditions; link budget and ground-station siting proven on the actual site;
degraded-navigation behaviour flown, not simulated; and the regulatory package in
§5 obtained. Corridor tolerances, monitor thresholds and range constants in this
repository are **initial simulation tuning values**, not flight-proven settings.

**What the system does not become with more flying.** It does not acquire
interdiction, identification of persons, or authority to act without a human. The
ceiling on this system is a fast, bounded, well-evidenced look at a cue, handed to
a person who decides.
