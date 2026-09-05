"""Export JSON Schema for the Hub controller protocol and domain contracts (consumed by the TypeScript Console)."""
import json
from pathlib import Path

from pydantic import TypeAdapter

from contracts import models as m
from contracts import protocol as p

out = Path(__file__).resolve().parent.parent / "contracts" / "schema"
out.mkdir(exist_ok=True)
(out / "controller_message.schema.json").write_text(json.dumps(p.controller_message.json_schema(), indent=2) + "\n")
(out / "hub_message.schema.json").write_text(json.dumps(p.hub_message.json_schema(), indent=2) + "\n")
domain = {
    name: TypeAdapter(getattr(m, name)).json_schema()
    for name in ["Detection", "MissionSpec", "FlightPlan", "ValidationResult", "IncidentReport", "DroneState", "ManualCommand", "ClampEvent", "Scenario"]
}
(out / "domain.schema.json").write_text(json.dumps(domain, indent=2) + "\n")
print("wrote", sorted(f.name for f in out.iterdir()))
