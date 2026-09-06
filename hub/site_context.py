"""Site context for the Triage Agent: which Zone a point falls in, what is normal there, and whether a maintenance window is open."""
from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from shapely.geometry import Point, Polygon

from contracts.models import Detection, SiteContext, Zone

SITE_CONTEXT = Path(__file__).resolve().parent.parent / "sim" / "site" / "site_context.json"
# innermost first: a point in the exclusion zone is also inside the protected area and the buffer
ZONE_PRIORITY = {"exclusion_zone": 0, "protected_area": 1, "service_yard": 1, "open_ground": 2}


class SiteKnowledge:
    def __init__(self, ctx: SiteContext):
        self.ctx = ctx
        self._polys = [(z, Polygon([(p.lon, p.lat) for p in z.ring])) for z in ctx.zones]

    @classmethod
    def load(cls, path: Path = SITE_CONTEXT) -> SiteKnowledge:
        return cls(SiteContext.model_validate_json(path.read_text()))

    def zone_at(self, lat: float, lon: float) -> Zone | None:
        hits = [z for z, poly in self._polys if poly.covers(Point(lon, lat))]
        if not hits:
            return None
        # smallest area wins among the highest-priority class (service yard beats the protected area it sits in)
        hits.sort(key=lambda z: (ZONE_PRIORITY.get(z.zone_class.value, 9), Polygon([(p.lon, p.lat) for p in z.ring]).area))
        return hits[0]

    def active_windows(self, zone_id: str | None, at: datetime) -> list:
        at = at if at.tzinfo else at.replace(tzinfo=UTC)
        return [w for w in self.ctx.maintenance_windows if (zone_id is None or w.zone_id == zone_id) and w.starts_at <= at <= w.ends_at]

    def brief_for(self, d: Detection) -> dict:
        """Everything the agent should know about where this Detection is."""
        lat = sum(p.lat for p in d.polygon) / len(d.polygon)
        lon = sum(p.lon for p in d.polygon) / len(d.polygon)
        zone = self.zone_at(lat, lon)
        windows = self.active_windows(zone.zone_id if zone else None, d.detected_at)
        return {
            "zone_id": zone.zone_id if zone else None,
            "zone_name": zone.name if zone else "outside every declared Zone",
            "zone_class": zone.zone_class.value if zone else None,
            "normally_present": zone.normally_present if zone else "",
            "active_windows": [{"description": w.description, "ends_at": w.ends_at.isoformat()} for w in windows],
            "site_notes": self.ctx.notes,
        }

    def prose(self, brief: dict) -> str:
        lines = [f"Zone: {brief['zone_name']} ({brief['zone_class'] or 'undeclared'}).", f"Normally present here: {brief['normally_present'] or 'unknown'}"]
        if brief["active_windows"]:
            for w in brief["active_windows"]:
                lines.append(f"ACTIVE maintenance window in this Zone: {w['description']} (until {w['ends_at']}).")
        else:
            lines.append("No maintenance window is declared for this Zone right now.")
        lines.append(f"Site notes: {brief['site_notes']}")
        return " ".join(lines)
