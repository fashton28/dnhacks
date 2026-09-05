# Threat model — Komati Power Station

Runtime paths in this document are relative to [`platform/`](..), this file's
parent directory.

## Site and framing

The modelled site is **Komati Power Station, Mpumalanga** — an Eskom coal station
whose last unit was retired in 2022 and which is designated critical
infrastructure (the National Key Point regime carried into the Critical
Infrastructure Protection Act). Decommissioning changes the threat picture rather
than removing it: generation plant becomes a very large quantity of unattended
copper, aluminium, steel and instrumentation, the guard force shrinks, and the
switchyard and its transmission connections remain live and operationally
important.

**Everything in this document is demonstrated in simulation.** No flight is
performed at Komati, no Eskom system is connected to, and no site data other than
publicly derivable geometry is used. Site geometry is the deterministic stub in
`site/site.stub.json` (see [`docs/SITE_CONTRACT.md`](SITE_CONTRACT.md)); the real
survey is the site owner's to supply.

## Scope

The system is an **observation and reporting** system with a deterministic safety
layer. It answers "what is happening at that point on the perimeter, and is the
report trustworthy" and hands the answer to a human.

### Out of scope — no interdiction of any kind

This is a hard boundary, not a phasing decision, and it is enforced by the
absence of the capability rather than by policy text:

- No kinetic or non-kinetic engagement of people, vehicles or aircraft: no net,
  capture, ram, dazzle, acoustic device, spray, projectile or payload of any kind.
  The airframe carries sensors only.
- No counter-drone effect. The RF rail is **receive-only by construction** — the
  SDR sidecar exposes no transmit API, gain-for-transmit mode, or configuration
  path — so jamming, spoofing or protocol takeover of a hostile drone cannot be
  commanded even by a fully compromised ground station.
- No pursuit to contact, no shadowing of an identified individual, no herding,
  no blocking of a vehicle or gate.
- No identification of persons. No facial recognition, gait recognition, plate
  reading, occupant counting, or matching against any watchlist or personnel
  register. Detector class confidence establishes the presence of an object
  class, never identity, intent or authorisation.
- No autonomous escalation to force, no automated call to an armed responder, and
  no automated instruction of any kind to a human responder. The system produces a
  report; a human decides.
- No offensive action against an attacker's infrastructure, including no attempt
  to locate, disrupt or retaliate against a jammer, a spoofer, or a hostile
  drone's pilot. Pilot-location fields in a passive RF event are evidence for the
  operator's report, nothing more.

### Also out of scope

Physical guarding, gate control, access-control integration, alarm-panel
integration, prosecution support beyond retained evidence, and any claim about
detection performance not backed by a row in [`docs/NUMBERS.md`](NUMBERS.md).

## Defence layers referenced below

| Layer | What it is | What it can decide |
|---|---|---|
| Cue rails | `CueAdapter` implementations — CCTV/VMS events, fence sensors, satellite change detection, SAR, SDR, passive RF-drone — normalised to one `anomaly` shape with `vehicleId`, `observedAt`, `ttl_s`, `confidence`, location | Nothing flies. A cue is an input; expired, invalid, duplicate, whitelisted or out-of-geofence cues cannot dispatch |
| Triage | The LLM, emitting **schema-bound JSON only** (a task, or a report) | What to look for and how urgent. Never a plan, coordinate, altitude, setpoint, mode change or tool invocation |
| Deterministic planner | Rule table over the task plus site geometry | Profile, altitude, route, orbit, hold, terminal action, time budget |
| Verifier | Deterministic pre-dispatch gate over the plan | `refuse` with named checks; one repair attempt; second rejection escalates |
| Companion validator | Vehicle-side re-validation and re-clamping of every accepted plan and every setpoint | `refuse`, and clamps that cannot be relaxed by config |
| Companion monitor | In-flight corridor, altitude-band, standoff, NFZ-buffer and geofence-margin checks at loop rate | `hold`, `rtl`, `escalate` |
| ArduPilot fence | Stock firmware fence and failsafes, loaded from the same site geometry | The final backstop; unreachable from the ground stack or the LLM |
| Signed commands | Privileged transitions (unattended-mode entry, envelope changes) require a signed command | Rejects unsigned or replayed privileged commands |
| Hash-chained audit | Append-only log; every wire message and audit entry carries `vehicleId` | Detects tampering and gaps after the fact |

Every failure in this document resolves to exactly one of `hold`, `rtl`,
`escalate`, `refuse`. Per-failure rows and their required assertions live in
[`docs/FAILURE_MODES.md`](FAILURE_MODES.md).

---

## A1 — Opportunistic theft and vandalism

**Likelihood: highest.** Small groups or individuals, unplanned, on foot, often
in daylight at the site's least-observed edges. This is the volume threat at any
decommissioned station.

| | |
|---|---|
| **Asset targeted** | Fencing itself, scrap steel, light fittings, small copper runs, unsecured tooling and spares; glass and instrumentation damaged for its own sake |
| **Attack path** | Walk or cut through a perimeter fence panel at a section with poor camera coverage → cross open ground → remove what can be carried → exit the same way |
| **Detects** | Cue rails — CCTV motion in a fence zone (event mode) or a fence sensor; triage classifies as `fence_gap` or `person`; deterministic planner produces an inspect profile with a 15 s hold at the cued fence section; the vehicle's RGB/thermal observation and the resulting report confirm or clear it |
| **Response** | `escalate` when the report verdict is escalate — human response team dispatched by the control room. `rtl` at end of sortie in every case. Nothing else |
| **Residual risk** | High-ish and accepted. A brief intrusion can complete inside the cue-to-observation latency; camera coverage gaps are the dominant limiter, not the autonomy; the system deters and evidences, it does not prevent |
| **Out of scope** | Interdiction of any kind (see above). The system will not follow a person off site, will not attempt identification, and will not loiter beyond its sortie cap to keep watch |

## A2 — Organised cable and metal theft

**Likelihood: high.** Syndicate activity against South African electricity
infrastructure is routine, resourced, night-preferring, vehicle-supported and
often informed. This is the threat that drives the design.

| | |
|---|---|
| **Asset targeted** | Bulk copper — cable runs, earth mats, transformer windings, busbar; aluminium conductor; large-value scrap moved by vehicle |
| **Attack path** | Reconnaissance (sometimes by drone, see A5) → vehicle approach on a service road or a cut in a remote perimeter section → sustained cutting over tens of minutes → load and exit; frequently timed against guard rotation or a known camera outage |
| **Detects** | Cue rails — CCTV event in a fence or yard zone, fence sensor, and satellite change detection as a slower site-integrity rail; RF and fence-zone motion correlated fresh gives priority 1; triage emits `vehicle` or `fence_gap`; planner selects inspect, altitude inside the site band, route buffered around NFZs; observation fuses RGB, thermal and LiDAR (a vehicle-sized cluster is 2–20 m² footprint, 1–4 m height; a fence gap is ≥ 2 m of missing expected profile in three consecutive scans) |
| **Response** | `escalate` on a confirming report, with evidence references and a hash-chained audit trail suitable for a human decision and later prosecution. `rtl` on sortie cap, battery reserve or wind. `hold` on any monitor trip |
| **Residual risk** | Medium. Night work is thermal-dependent and a night mission is refused without a healthy thermal rail; a determined crew that defeats cameras in a zone leaves that zone blind; the system's contribution is time-to-evidence and confidence in the evidence, not physical prevention |
| **Out of scope** | Interdiction, pursuit, vehicle blocking, plate reading, and any automated dispatch of an armed response |

## A3 — Insider

**Likelihood: moderate to high, and the hardest to see.** Contractor, guard,
decommissioning staff, or a legitimate visitor abusing legitimate access. An
insider is inside the normalcy model, not outside the fence.

| | |
|---|---|
| **Asset targeted** | The same metal as A2, plus the security system itself: camera positions, patrol timing, whitelists, normalcy windows, and the knowledge of where coverage is thin |
| **Attack path** | Use an authorised gate and an authorised window → move material to a staging point → remove it under cover of a declared delivery or maintenance window. Or: suppress the system — add a whitelist entry, widen a delivery window, take a camera "offline for maintenance", or request unattended mode at a convenient hour |
| **Detects** | Cue rails still see the movement, but normalcy suppresses the cue — which is the point of the attack. The durable detections are in the **hash-chained audit**: whitelist and normalcy changes, camera health transitions, unattended-mode entries (only ever via a **signed command**), approval issuance, and every dispatch and refusal, each carrying `vehicleId` and an actor. Blue-force RF whitelisting requires an authenticated own-vehicle telemetry fingerprint and can never be established by a model assertion. Satellite change detection is an independent rail an insider inside the VMS cannot silence |
| **Response** | `escalate` — an out-of-window movement, or a configuration change without a matching signed command, produces an operator-visible health event. `refuse` for any unattended dispatch outside `UNATTENDED_ENVELOPE`, whatever the configuration says. The system does not accuse anyone; it produces the record |
| **Residual risk** | High, and honestly so. An insider with configuration rights can degrade detection for a shift. The mitigation is that they cannot do so silently: suppression leaves a chained, signed, attributable trail. Detection is retrospective, and depends on someone reading the audit |
| **Out of scope** | Personnel vetting, behavioural analytics on staff, identification of individuals from imagery, and any covert monitoring of workers. The no-image zones in [`docs/CONOPS.md`](CONOPS.md) exist partly to keep this system from becoming a staff-surveillance tool |

## A4 — Sabotage

**Likelihood: lower, consequence highest.** Komati's switchyard and its
transmission connections remain part of the grid even with generation retired, so
the consequence tail here is disproportionate to the frequency.

| | |
|---|---|
| **Asset targeted** | Switchyard equipment, transformers, control and protection cabling, remaining structures (chimney, boiler house), and the site's grid connection |
| **Attack path** | Deliberate entry aimed at damage rather than removal — cutting protection cabling, damaging bushings or a transformer, fire-setting in a cable basement, or structural attack |
| **Detects** | Cue rails on the switchyard and structure zones; triage emits `structure`, which the planner maps to a **survey** profile. Critically, the switchyard is a **no-fly zone with a 120 m ceiling above the 20–80 m site band**, so it is a full no-go: the planner routes around the 25 m buffered polygon, the verifier refuses any plan that enters it, and the companion validator refuses it again. Observation is therefore standoff observation of the switchyard from outside its buffer, at survey lateral tolerance |
| **Response** | `escalate` on a confirming report, at the top of the escalation chain in [`docs/CONOPS.md`](CONOPS.md). `refuse` for any plan or operator action that would put the vehicle inside the switchyard NFZ, including a manual drag of the target into it |
| **Residual risk** | Medium-high. Standoff observation of an energised switchyard is intentionally limited — the system will not trade an NFZ for a better camera angle, so some sabotage inside the switchyard is observable only from outside it, or not at all. Fast, decisive sabotage completes well inside any dispatch cycle |
| **Out of scope** | Any interdiction, any entry into the NFZ under any authority including operator override, and any automated notification of emergency services |

## A5 — Hostile small drones

**Likelihood: moderate and rising.** Most realistically reconnaissance for a
later A2 event; occasionally nuisance or intrusion in its own right.

| | |
|---|---|
| **Asset targeted** | Information — camera positions, guard routine, stockpile locations, gaps in the fence line. Secondarily, airspace conflict with our own vehicle |
| **Attack path** | Small multirotor launched from outside the perimeter, overflying the site to survey it, or shadowing our vehicle to learn its patrol pattern |
| **Detects** | The **passive RF-drone rail** (a receive-only event adapter: `source: rf_drone`, `kind: hostile_drone`, band, power delta, optional location and pilot location, confidence). It is an airspace and attribution rail, not a targeting rail. Correlation with SDR interference escalates without flight |
| **Response** | **Phase-specific.** A hostile drone inside the geofence pre-flight → `refuse` (verifier `airspace` check; approval stays disabled). A valid detection after takeoff → `hold` within 5 s, and only an operator choice of continue or RTL leaves that state. The LLM cannot select this branch |
| **Residual risk** | Medium. A passive rail sees only cooperative or RF-emitting airframes; a fibre-controlled or autonomous, radio-silent aircraft is invisible to it. Deconfliction is by holding our own vehicle, which is the only safe action available |
| **Out of scope** | **All counter-UAS effect.** No jamming, no spoofing, no takeover, no capture, no interception, no pursuit, no attempt to locate or approach the pilot. The system yields airspace and reports |

## A6 — Cyber attack on this system

**Likelihood: moderate, and it is the adversary that most directly targets the
autonomy.** Treated per vector, because the layer that catches each one differs.

### A6.1 Cue flooding

| | |
|---|---|
| **Asset targeted** | Availability — exhaust sorties, battery and operator attention so a real event is missed, or so the site is left with an airborne vehicle when it matters |
| **Attack path** | Trigger many genuine-looking cues (fence tampering across many zones, injected VMS events if the VMS is reachable, RF noise) faster than they can be flown |
| **Detects** | Cue rails — per-camera rate limits applied **before** a shared dispatch budget; duplicate, expired (`ttl_s`) and whitelisted cues are dropped without reaching triage; unattended mode caps sorties at **2 per hour** |
| **Response** | `refuse` for cues over budget, `escalate` as a health event when the budget is exhausted so the operator learns that the site is saturated rather than quiet |
| **Residual risk** | Medium. Saturation still denies coverage — the honest outcome is a loud, evidenced denial rather than a silent one. Prioritisation between simultaneous real cues remains a human decision |
| **Out of scope** | Blocking, blacklisting, or acting against the source of the cues |

### A6.2 Luring

| | |
|---|---|
| **Asset targeted** | The vehicle itself, and coverage of the real target — draw the aircraft to one corner of the site so another corner is unobserved, or draw it low over a prepared position |
| **Attack path** | A deliberately conspicuous decoy at a chosen fence section, repeated to establish a pattern; possibly paired with a real event elsewhere |
| **Detects** | The **deterministic planner** is the defence: altitude comes from the profile band intersected with the site band, never from the cue; route is a straight leg or the shortest via-point detour around buffered NFZs; orbit radius is shrunk to clear NFZ and geofence but **never below standoff**; `laps = 1`; hold is 15 s and only for `fence_gap`. A cue cannot make the vehicle fly lower, closer, longer or somewhere else. Cues outside the operational geofence are rejected with a warning and never dispatch |
| **Response** | `refuse` for an out-of-geofence or geometrically infeasible task. Otherwise the sortie flies the same bounded shape it always flies, and `rtl` ends it on the time budget |
| **Residual risk** | Medium. Attention can still be diverted — a decoy consumes one of two hourly unattended sorties. What a lure cannot do is change the flight envelope |
| **Out of scope** | Any adaptive "chase the interesting thing" behaviour that would let observed content steer geometry |

### A6.3 Command injection

| | |
|---|---|
| **Asset targeted** | Direct control of the vehicle, or of the mode it operates in |
| **Attack path** | Forge or replay wire messages on the control link; or attempt prompt injection through cue metadata, VMS text fields, or imagery so the LLM emits something dangerous |
| **Detects** | The LLM is **structurally unable to help**: it emits schema-bound JSON for tasks and reports only, and there is no path by which it produces a plan, coordinate, altitude, tool call, setpoint or mode change. Everything downstream is deterministic. Privileged transitions require **signed commands**; the companion validator re-validates and re-clamps every accepted plan and every setpoint against limits that config cannot relax; the monitor re-checks in flight; the **ArduPilot fence** is loaded from site geometry and is unreachable from the ground stack |
| **Response** | `refuse` for an unsigned, replayed or schema-invalid message. `hold` or `rtl` if an injected setpoint is nonetheless flown toward a boundary. `escalate` for any rejected privileged command — an attempt is itself reportable |
| **Residual risk** | Low-medium for the flight envelope, higher for availability. An attacker on the link can plausibly deny service (which resolves to `hold` then `rtl`); moving the vehicle outside its envelope requires defeating the validator, the monitor and the firmware fence independently |
| **Out of scope** | Network security of the site's own VMS and IT estate, and any active response to an intruder on the link |

### A6.4 GNSS jamming and spoofing

| | |
|---|---|
| **Asset targeted** | Navigation integrity — push the vehicle off its true position, into a structure, an NFZ, or off site |
| **Attack path** | Broadcast noise on GNSS L1 (jamming), or a coherent false constellation (spoofing) that walks the estimated position away from truth |
| **Detects** | The **SDR rail** (receive-only, 4096-point FFT, rolling 60 s floor) declares `gnss_interference` when the noise floor rises ≥ 6 dB for ≥ 2 s or a narrowband peak rises ≥ 15 dB within ±1 MHz of the carrier. Independently, the **companion alone** owns the EKF source vote, evaluated every 2 s from onboard evidence: GPS speed accuracy 0.3 m/s healthy and above 1.0 m/s unusable; extnav preferred on GPS loss only when LiDAR-inertial odometry is healthy; optflow only when quality ≥ 50 and velocity innovation ≤ 0.15 m/s |
| **Response** | `hold` while the source vote runs. `refuse` any new mission while `navSource != gps`, even with a healthy fallback. `escalate` as `probable interference` when a source change and a `gnss_interference` event correlate within 60 s. With no healthy fallback the vehicle holds and refuses missions |
| **Residual risk** | Medium. Slow, well-crafted spoofing that keeps reported accuracy plausible is the hard case and is not claimed to be solved; the mitigations are that the ground station and the LLM cannot command a source switch, that a degraded nav source blocks dispatch rather than degrading it, and that the firmware fence still applies to whatever position the EKF believes |
| **Out of scope** | Locating or countering the jammer. Anti-spoof cryptographic GNSS, multi-antenna attitude checks and RAIM-class integrity monitoring are noted as the real fix and are not implemented here |

### A6.5 Ground-station compromise

| | |
|---|---|
| **Asset targeted** | The operator surface — the machine that dispatches, approves and escalates. The worst realistic cyber case |
| **Attack path** | Malware or credential theft on the ground station; the attacker then dispatches at will, suppresses escalations, edits the operator's view of the site, or tries to enter unattended mode and fly the vehicle somewhere useful to them |
| **Detects** | Defence is by **partition, not by trusting the ground station**. The companion re-validates every plan and clamps every setpoint against its own limits; the monitor enforces corridor, band, standoff and geofence margin in flight; the ArduPilot fence is loaded independently and cannot be reached from the ground stack; unattended-mode entry needs a **signed command** the ground station alone cannot mint; the **hash-chained audit** makes suppression detectable — a chain gap or a mismatched mission-record hash causes the monitor to **refuse dispatch** rather than run against an unverifiable record; escalations that never leave the site produce an `escalation_undelivered` health event and a local outbox entry |
| **Response** | `refuse` on hash mismatch or unsigned privileged command; `hold` then `rtl` on the companion's own timers when the ground link is lost or untrusted; `escalate` for every rejected privileged command and every undelivered escalation |
| **Residual risk** | Medium-high for confidentiality and availability, low for the flight envelope. A compromised ground station can see evidence it should not, can delay a human response, and can waste sorties. It cannot fly the vehicle outside the envelope, cannot silence the chained audit without leaving a gap, and cannot obtain any interdiction capability because none exists |
| **Out of scope** | Endpoint security, identity management, and key custody for signed commands are the deploying organisation's, not this system's. Remote wipe, active defence and attacker attribution are not implemented |

---

## Cross-cutting invariants

1. **The LLM never owns a response.** Ground validation may `refuse` or
   `escalate`; companion watchdogs may `hold`, `refuse` or `rtl`; ArduPilot
   firmware owns the final fence and heartbeat backstops.
2. **Nothing on the demo or test path blocks on the network**, so an adversary who
   can cut connectivity degrades availability, never determinism.
3. **`vehicleId` is on every wire message and every audit entry**, so no event is
   attributable to "the system" rather than to a specific vehicle.
4. **An empty valid sensor frame is "no detections"; a missing, stale or failed
   frame is "no observation."** Conflating them is how a suppressed camera becomes
   a clean bill of health, so the distinction is preserved in the recogniser, the
   fixtures, the UI and the reports.
5. **Every response in this document is one of `hold`, `rtl`, `escalate`,
   `refuse`.** There is no fifth option, and in particular there is no
   interdiction option, at any layer, under any authority.
