# ARGUS demo runbook

One idea, told twice: the same picture from above gets a different answer depending on what the Drone finds, and every decision the AI makes is checked by something that is not an AI.

## Before you present (10 minutes)

1. Top up the Anthropic API balance. Live mode fails over to the rule-based path when the account is empty, but the live agent is the demo.
2. Restart the whole stack with fresh batteries and parameters:

    ```bash
    pkill -9 -f "uvicorn hub.server"; pkill -9 -f launch_sim.py; pkill -9 -f sim.bridge; pkill -9 -f bin/arducopter; pkill -9 -f headless_renderer.py
    uv run python scripts/launch_sim.py --fleet 3 --speedup 1 --wipe --with-hub --renderer
    ```

3. Wait 45 seconds, then check `curl -s localhost:8000/autonomy` shows `"llm_mode":"live","flight_mode":"agent"`.
4. Open the dashboard at http://localhost:8000/ and hard-reload it (Cmd+Shift+R). Close every other Console or dashboard tab; more than one full render halves the frame rate.
5. Optional second screen: the Console World view with a chase camera, http://localhost:8000/console/?dist=6, then press F when a Drone is selected.
6. Dashboard: Baseline once, so the overhead pass has a before image.

## Act 1, the hero: transformer fire (about 4 minutes live)

1. Ops: **Transformer fire**. The World view flies to the switchyard; the smoke column is visible from orbit.
2. Ops: **Detect**. A large change appears in the switchyard.
3. **Dispatch**. Narrate the Mission view as it fills, in this order:
   - Triage decision: dispatch, with the Zone reasoning: smoke at a transformer is a fire until proven otherwise.
   - Drone choice, with the passed-over candidates and why.
   - The envelope the agent declared, and the Safety Validator refusing it near the reactor and shrinking it until it passes. Nothing has moved yet.
   - Agent in control: a high standoff south of the plume, upwind; RGB first, then thermal; each step with its reason. The airframe banks into its turns.
   - Thermal: the bay saturates the sensor.
   - Report: escalate, critical, de-energize the bay and dispatch fire response, keep personnel upwind.

While it flies, say the line: the model decides where to look; the validator decides where it may go; ArduPilot's own fence is the last line.

## Act 2, the contrast: steam release (about 3 minutes live)

1. Ops: **Reset**, then **Steam release**. The World view flies to the auxiliary building roof. From above it looks like Act 1.
2. **Detect**, **Dispatch**. Triage dispatches again: nothing was declared.
3. On station the agent switches to thermal and the plume reads cool: water vapour, no hot source, structure intact.
4. Report: log only, an unplanned relief lift for maintenance, no emergency.

Same detection, opposite answer, decided by a sensor choice the agent made on station.

## Codas (30 seconds each)

- **Red team**: `curl -s -X POST localhost:8000/redteam/bad_plan` in a terminal. The validator refuses the agent's illegal first envelope on screen, names the rule, and the repair passes.
- **Human in the loop**: select an idle Drone, press W, then D to turn. The HUD shows arming, then taking off, then the keys are live. Fly toward the fence and the clamp banner shows the same rules stopping a human.

## If the API misbehaves

Every live model call falls back to the rule-based path and says so on the trail ("model unavailable"). The flights still happen, the reports still read right (fire escalates, steam logs). To run the whole demo without the API on purpose, start the Hub with `ARGUS_LLM_MODE=mock`; each dispatch then takes about 90 seconds on the real autopilots.

## Numbers worth saying out loud

- Real ArduCopter flight code flies every Drone; the Hub only sends it what the validator approved.
- Thermal peak at the fire about 640 C; at the vent about 46 C.
- Both front ends hold 60 fps with the fleet flying; telemetry at 20 Hz with per-frame interpolation.
