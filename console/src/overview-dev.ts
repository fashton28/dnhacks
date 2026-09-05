// Standalone harness for the Overview: full-screen map fed by the Hub live feed.
import { createOverview } from "./overview";
import { api, liveFeed } from "./hub";

const site = await (await fetch("./site.json")).json();
const siteGeo = await (await fetch("./site.geojson")).json();
const el = document.getElementById("ov")!;
let selected: string | null = null;
const ov = createOverview(el, { site, siteGeo, onSelect: (id) => { selected = id; ov.setSelected(id); console.log("selected", id); } });
(window as any).__ov = ov;
api<any>("/scene").then((st) => ov.setScene(st)).catch(() => {});  // the Hub snapshot carries no scene; fetch it once
liveFeed((ev) => {
  if (ev.type === "snapshot") { for (const s of ev.drones) ov.updateDrone(s); if (ev.scene) ov.setScene(ev.scene); }
  else if (ev.type === "drone_state") { ov.updateDrone(ev.state); if (!selected) { selected = ev.state.drone_id; ov.setSelected(selected); } }
  else if (ev.type === "scene") ov.setScene(ev.state);
}, (ok) => console.log("hub", ok ? "live" : "reconnecting"));
