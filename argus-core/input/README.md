# Put simulation screenshots here

For the standalone demo, add two image files with these exact names:

```text
input/before.png
input/after.png
```

They should be two overhead screenshots of the **same simulated view**:

- `before.png`: site before an event
- `after.png`: site after you add the simulated fence change, vehicle, object,
  plume, or other scenario change

Then run from the `argus-core` folder:

```bash
python3 run_vision_pipeline.py
```

The program uses Gemini to compare the two images, creates candidate
simulator detections, plans and validates a simulated drone inspection route,
and writes dashboard-ready events to `runs/dashboard_events.jsonl`.

Until the environment team supplies camera calibration, the program maps the
full screenshot to the included fictional policy geofence. That makes this an
independent demo route, not a real-world geographic mapping.
