import React from 'react';
import { Video, Globe, Crosshair, SlidersHorizontal, Radar, ScrollText, ShieldCheck, FileText } from 'lucide-react';
import { useArgus } from '../store';

export type View = 'flight' | 'world' | 'mission';
export type DrawerId = 'ops' | 'fleet' | 'log' | 'safety' | 'reports';

const VIEWS: { id: View; label: string; icon: React.ReactNode; title: string }[] = [
  { id: 'flight', label: 'Flight', icon: <Video size={18} />, title: 'Live camera of the selected Drone' },
  { id: 'world', label: 'World', icon: <Globe size={18} />, title: 'Photoreal World view of the Site' },
  { id: 'mission', label: 'Mission', icon: <Crosshair size={18} />, title: 'Site map: Detections, route, agent and Safety Validator' },
];
const DRAWERS: { id: DrawerId; label: string; icon: React.ReactNode; title: string }[] = [
  { id: 'ops', label: 'Ops', icon: <SlidersHorizontal size={18} />, title: 'Operations: overhead, scenarios, camera, manual control' },
  { id: 'fleet', label: 'Fleet', icon: <Radar size={18} />, title: 'Fleet and telemetry' },
  { id: 'log', label: 'Log', icon: <ScrollText size={18} />, title: 'Event log' },
  { id: 'safety', label: 'Safety', icon: <ShieldCheck size={18} />, title: 'Safety Validator and manual-control clamps' },
  { id: 'reports', label: 'Reports', icon: <FileText size={18} />, title: 'Findings from every dispatch' },
];

/** Left icon rail: three views of the same operation, then drawers that slide over the view. */
export function Rail({ view, drawer, onView, onDrawer }: { view: View; drawer: DrawerId | null; onView: (v: View) => void; onDrawer: (d: DrawerId | null) => void }): React.ReactElement {
  const detections = useArgus((s) => s.detections.length);
  const rejected = useArgus((s) => s.validation?.verdict === 'reject');
  const reports = useArgus((s) => Object.keys(s.reports).length);
  return (
    <nav className="a-glass a-rail" aria-label="Views">
      {VIEWS.map((v) => (
        <button key={v.id} className="a-railbtn" data-on={view === v.id} onClick={() => onView(v.id)} title={v.title}
          data-badge={v.id === 'mission' && detections > 0 ? String(detections) : undefined}>{v.icon}<span>{v.label}</span></button>
      ))}
      <div className="a-railsep" />
      {DRAWERS.map((d) => (
        <button key={d.id} className="a-railbtn" data-on={drawer === d.id} onClick={() => onDrawer(drawer === d.id ? null : d.id)} title={d.title}
          data-badge={d.id === 'safety' && rejected ? '!' : d.id === 'reports' && reports > 0 ? String(reports) : undefined}>{d.icon}<span>{d.label}</span></button>
      ))}
    </nav>
  );
}
