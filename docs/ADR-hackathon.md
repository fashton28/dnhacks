# ADR — hackathon retrofit (power-plant security system)

Decisions made while retrofitting the Eye in the Sky monorepo into the
two-layer AI security demo (satellite change detection → LLM mission plan →
deterministic trust layer → SITL flight → observation → incident report).
Format: one numbered decision per row of work; append, don't rewrite.
Per the working agreement: we don't stop to ask — we decide, record here, move on.

## D1 — Site stub home = SITL default home (CMAC)

`site/site.stub.json` puts home at `-35.363261, 149.16523, 584 m` — ArduPilot
SITL's default CMAC home — so the stock SITL world flies the stub with zero
parameter changes. When the site owner's `site/site.json` lands with a real
plant location, nothing in code changes; SITL home comes from the same file.

## D2 — Site file selected by `EIS_SITE_FILE`

Default `site/site.json`; the demo/test path sets
`EIS_SITE_FILE=site/site.stub.json`. Cutting over to the real site model is
deleting that env var, nothing else. Schema + semantics live in
`docs/SITE_CONTRACT.md`; additions go there, never hardcoded.

## D3 — NFZ ceiling semantics

Flight inside an NFZ polygon at or below `ceiling_m` AGL is forbidden;
overflight above it is allowed. The stub switchyard ceiling (120 m) sits above
the alt band (20–60 m), making it a full no-go for this system — which is what
the scripted "plan fails verification" demo relies on.

## D4 — Offline-first fallbacks, selected by env vars

Nothing on the demo or test path may block on the network.

- `EIS_PLANNER_MODE` = `scripted` (default) | `live` — ScriptedPlanner vs live LLM.
- `EIS_SAT_MODE` = `baked` (default) | `live` — baked change-detection result vs
  computing it from the baked Sentinel-2 tiles (still offline) / fetched tiles.

Live modes are opt-in flags on the demo scripts only.

## D5 — Test strategy on this box

Ground: `npm run typecheck` + `lint` + unit tests run natively on Windows per
phase. Companion: pytest in a Python 3.10–3.12 venv (numpy 1.26.4 pin does not
build on 3.14). The SITL e2e gate runs under WSL2 with the ground side on
Windows; each phase commits green on everything runnable natively, and the
full gate is the Phase 4 exit criterion.

## D6 — Placeholder staging images are stdlib-generated PNGs

`site/staging/stage-*.png` are generated 320×240 PNGs (no PIL/opencv needed at
generation time): stage-a shows a crude vehicle (truth `vehicle`), stage-b an
empty pad (truth `false_alarm`). Live vision runs YOLO on whatever image the
site file points at; scripted paths use the `truth` field directly.

## D7 — `requestId` is ground-side correlation only

Wire acks keep correlating by command **name** (the existing FIFO match in
LiveDataProvider); `requestId` lives inside the MissionPlan/Verification
payloads for ground-side plan↔verdict correlation. CommandAck is unchanged.

## D8 — Toolchain reality: uv-managed 3.12 venv; SITL in Docker

WSL2 on this box has only the docker-desktop utility distro (no usable
userland), so the original "SITL under WSL2" assumption does not hold here.
Companion tests run in a uv-managed CPython 3.12 venv at `companion/.venv`
(numpy 1.26.4 pin does not build on the system 3.14). The Phase 4 e2e gate
targets ArduCopter SITL in a Docker container exposing TCP MAVLink
(`tcp:127.0.0.1:5760`); scripts keep a native/WSL2 path for boxes that have
a Linux userland.
