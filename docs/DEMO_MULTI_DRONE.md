# Multi-drone response preset

**Story:** two columns appear at Meridian Station at the same time. One is a
transformer fire in the switchyard, the other a relief-vent steam release on the
auxiliary building. ARGUS selects two available drones, validates their flight
envelopes, inspects both alerts with RGB and thermal cameras, and issues separate
reports. A fleet of three leaves one drone available for another incident.

The [preset](../demo/presets/multi_drone_response.json) fixes the two incidents and
their initial unconfirmed alerts. Drone IDs, waypoints and final assessments come
from the Hub's existing autonomy pipeline. The two dispatch requests run
concurrently. The Hub reserves each selected drone before another dispatch can
select it; active missions and manual-control sessions exclude a drone from
selection. The earlier `ARGUS_FLIGHT_MODE=plan` pipeline remains serialized.

## Run

Start the three-drone simulator from the [main runbook](DEMO.md), using
`ARGUS_FLIGHT_MODE=agent`. Restart the Hub after installing this change. Use a
fresh scene and idle drones; the command refuses an occupied scene or fewer than
two eligible drones. It does not reset existing missions or scenarios.

From the repository root, preview the preset:

```sh
uv run python scripts/demo_response.py
```

Then seed both alerts and start their autonomous responses:

```sh
uv run python scripts/demo_response.py --run
```

Use `--hub http://127.0.0.1:8000` to select another running Hub. The command waits
for both dispatch outcomes, prints the reports as JSON, and exits unsuccessfully
if two distinct drones did not complete successful, overlapping inspections (the
recorded mission start and finish times must overlap). It does not retry
dispatches on network errors: inspect the dashboard before retrying because a
flight may still be active. Wait for return and landing before resetting the scene
for another presentation.

### Windows or Linux rehearsal without ArduPilot

Use the existing fake-drone backend with the actual Hub. In PowerShell, start the
Hub in one terminal:

```powershell
$env:ARGUS_LLM_MODE = "mock"
$env:ARGUS_FLIGHT_MODE = "agent"
uv run python -m uvicorn hub.server:app --host 127.0.0.1 --port 8000
```

Start each drone in its own terminal (these commands also work on Linux):

```sh
uv run python -m sim.fake_drone.fake_drone --id drone-1 --home 35 -85
uv run python -m sim.fake_drone.fake_drone --id drone-2 --home 43 -85
uv run python -m sim.fake_drone.fake_drone --id drone-3 --home 51 -85
```

For a Linux mock Hub, prefix the `uvicorn` command with
`ARGUS_LLM_MODE=mock ARGUS_FLIGHT_MODE=agent`. Open the built dashboard at
`http://127.0.0.1:8000/gcs/` or the World view at
`http://127.0.0.1:8000/console/`, then run the preset. Existing pause and abort
controls remain available independently for each mission.

## Presenter beats

1. Show all three drones idle. Explain that both incoming alerts are unconfirmed.
2. Run the preset once. Show two different drone selections and two active
   missions, with the third drone still available.
3. Follow each drone's RGB and thermal inspection and its validator events.
4. Compare the reports: in mock rehearsal, the switchyard fire escalates as
   critical, while the cooler steam plume is logged. Live model results may vary.
5. Show both drones returning and landing, and their separate evidence records.

Say: “Two simultaneous alerts, two independently assigned inspections. Each
drone gathers evidence; the resulting reports distinguish the fire from steam.”

## What this demonstrates

This is a simulator response preset. Initial detections are explicitly labelled
`seeded-demo-alert` and have empty overhead-image references; they are not outputs
of a vision recognition algorithm. Mock mode uses the existing deterministic
sensor sweep and scene-based observations. Live mode uses the configured model
and renderer, with the application's existing labelled fallbacks. Do not present
mock observations as measured temperatures or independently recognized objects.

The demo exercises simultaneous mission execution and fleet allocation. It does
not add coordinated formation flight or inter-drone collision avoidance. Existing
geofences, envelope validation, battery checks and operator controls still apply.
Real aircraft operation and live model performance require separate validation.

## Verification

- `.venv/Scripts/python.exe -m pytest tests/test_demo_response.py -q`: **5 passed**.
  The integration test uses three fake drones and the actual Hub APIs, checks
  overlapping missions on distinct drones, separate RGB/thermal evidence and
  incident records, opposite fire/steam decisions, both landings and an idle
  reserve drone. Additional tests cover reserved/manual drones, insufficient
  fleet preflight, serial responses and failsafe hard stops.
- `.venv/Scripts/python.exe scripts/demo_response.py`: preview succeeded; no
  requests or flights are made without `--run`.
- `git diff --check`: passed (only Windows line-ending notices).

Live model calls, ArduPilot SITL, browser presentation and physical aircraft were
not exercised for this addition. The fake-drone tests verify the response
pipeline, not visual recognition accuracy or multi-aircraft collision avoidance.
