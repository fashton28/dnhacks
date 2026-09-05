// Same flat-earth frame as contracts/site.py: ENU metres from the Site anchor.
export type Anchor = { lat: number; lon: number };
const R = 6378137.0;
export function latlonToEnu(a: Anchor, lat: number, lon: number): [number, number] {
  const y = ((lat - a.lat) * Math.PI / 180) * R;
  const x = ((lon - a.lon) * Math.PI / 180) * R * Math.cos(a.lat * Math.PI / 180);
  return [x, y];
}
export function enuToLatlon(a: Anchor, x: number, y: number): [number, number] {
  const lat = a.lat + (y / R) * 180 / Math.PI;
  const lon = a.lon + (x / (R * Math.cos(a.lat * Math.PI / 180))) * 180 / Math.PI;
  return [lat, lon];
}
