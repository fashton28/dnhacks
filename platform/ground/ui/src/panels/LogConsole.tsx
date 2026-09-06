/* LogConsole — the statusText stream as a filterable, auto-scrolling list,
 * with the recording toggle and (when the host offers one) a log-browser
 * button in the header. */
import React from 'react';
import { FolderOpen } from 'lucide-react';
import { Panel } from '@/components/Panel';
import { Tabs } from '@/components/Tabs';
import { Badge } from '@/components/Badge';
import { IconButton } from '@/components/IconButton';
import type { StatusText } from '@/contract';

export interface LogConsoleProps {
  logs: StatusText[];
  recording: boolean;
  onToggleRecord: () => void;
  onOpenBrowser?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Filtering and formatting — pure, exported for tests                 */
/* ------------------------------------------------------------------ */

type Severity = StatusText['severity'];

export type LogFilter = 'all' | 'warn' | 'info';

export const LOG_FILTERS: { id: LogFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'warn', label: 'Alerts' },
  { id: 'info', label: 'Info' },
];

const ADMITS: Readonly<Record<LogFilter, (s: Severity) => boolean>> = {
  all: () => true,
  warn: (s) => s !== 'info',
  info: (s) => s === 'info',
};

export function logMatchesFilter(entry: Pick<StatusText, 'severity'>, filter: LogFilter): boolean {
  return (ADMITS[filter] ?? ADMITS.all)(entry.severity);
}

export function filterLogs<T extends Pick<StatusText, 'severity'>>(logs: readonly T[], filter: LogFilter): T[] {
  return logs.filter((entry) => logMatchesFilter(entry, filter));
}

/** Fixed-width severity tag ("ERR " keeps the column aligned). */
export const SEVERITY_TAG: Readonly<Record<Severity, string>> = {
  info: 'INFO',
  warning: 'WARN',
  error: 'ERR ',
  critical: 'CRIT',
};

const SEVERITY_FG: Readonly<Record<Severity, string>> = {
  info: 'var(--text-tertiary)',
  warning: 'var(--caution-fg)',
  error: 'var(--danger-fg)',
  critical: 'var(--danger-fg)',
};

/** Local wall-clock HH:MM:SS for an epoch-ms timestamp. */
export function logClock(ts: number): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8);
}

/* ------------------------------------------------------------------ */
/*  Pieces                                                              */
/* ------------------------------------------------------------------ */

function LogRow({ entry }: { entry: StatusText }) {
  const fg = SEVERITY_FG[entry.severity];
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '1px 12px',
        alignItems: 'baseline',
        background: entry.severity === 'critical' ? 'var(--red-tint)' : 'transparent',
      }}
    >
      <time style={{ color: 'var(--text-disabled)', flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{logClock(entry.ts)}</time>
      <span style={{ color: fg, fontWeight: 600, flex: 'none', letterSpacing: '0.04em' }}>{SEVERITY_TAG[entry.severity]}</span>
      <span style={{ color: entry.severity === 'info' ? 'var(--text-secondary)' : fg }}>{entry.text}</span>
    </div>
  );
}

function RecordToggle({ recording, onToggle }: { recording: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={recording}
      title={recording ? 'Stop recording' : 'Start recording'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 10px',
        background: recording ? 'var(--red-tint)' : 'var(--surface-input)',
        border: `1px solid ${recording ? 'var(--red-line)' : 'var(--border-input)'}`,
        borderRadius: 'var(--radius-sm)',
        color: recording ? 'var(--danger-fg)' : 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: recording ? 2 : '50%', background: recording ? 'var(--red)' : 'var(--text-tertiary)' }}
      />
      {recording ? 'REC' : 'Record'}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

export function LogConsole({ logs, recording, onToggleRecord, onOpenBrowser }: LogConsoleProps) {
  const [filter, setFilter] = React.useState<LogFilter>('all');
  const listRef = React.useRef<HTMLDivElement>(null);
  const visible = React.useMemo(() => filterLogs(logs, filter), [logs, filter]);

  // Follow the tail on every change of what is shown. Keyed on the array, not
  // its length: the app keeps `logs` as a capped ring buffer, whose length
  // stops changing once it is full.
  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [visible]);

  return (
    <Panel
      title="Event log"
      pad={false}
      status={<Badge tone="neutral" mono>{logs.length}</Badge>}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tabs size="sm" value={filter} onChange={(id) => setFilter(id as LogFilter)} items={LOG_FILTERS} />
          <RecordToggle recording={recording} onToggle={onToggleRecord} />
          {onOpenBrowser && (
            <IconButton icon={<FolderOpen size={15} />} title="Open log browser" onClick={onOpenBrowser} variant="solid" size="sm" />
          )}
        </div>
      }
      style={{ height: '100%' }}
    >
      <div
        ref={listRef}
        style={{ height: '100%', overflow: 'auto', padding: '6px 0', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.65 }}
      >
        {visible.length === 0 ? (
          <div style={{ padding: '8px 12px', color: 'var(--text-disabled)' }}>No events.</div>
        ) : (
          visible.map((entry, i) => <LogRow key={`${entry.ts}-${i}`} entry={entry} />)
        )}
      </div>
    </Panel>
  );
}
