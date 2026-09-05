/* ============================================================================
 * Tiny markdown renderer for incident reports (no dependencies).
 * Supports exactly what the eis-planner report writer emits: #/##/### headings,
 * paragraphs, **bold**, `inline code`, > blockquotes, and -/1. lists.
 * ========================================================================== */
import React from 'react';

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  // Split on **bold** and `code` spans, preserving order.
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={`${keyBase}-b${i}`} style={{ color: 'var(--text-primary)' }}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(
        <code
          key={`${keyBase}-c${i}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.92em',
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 3,
            padding: '0 4px',
            wordBreak: 'break-all',
          }}
        >
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const H_STYLE: Record<number, React.CSSProperties> = {
  1: { fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)', margin: '2px 0 6px' },
  2: {
    fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--text-secondary)',
    textTransform: 'uppercase', letterSpacing: '0.07em', margin: '12px 0 4px',
  },
  3: { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)', margin: '10px 0 4px' },
};

/** Render report markdown into styled React nodes. */
export function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = (): void => {
    if (para.length === 0) return;
    const text = para.join(' ');
    blocks.push(
      <p key={`p${key++}`} style={{ margin: '0 0 8px', lineHeight: 1.55 }}>
        {renderInline(text, `p${key}`)}
      </p>,
    );
    para = [];
  };
  const flushList = (): void => {
    if (!list) return;
    const items = list.items.map((it, i) => (
      <li key={i} style={{ margin: '0 0 3px' }}>{renderInline(it, `li${key}-${i}`)}</li>
    ));
    blocks.push(
      list.ordered
        ? <ol key={`l${key++}`} style={{ margin: '0 0 8px', paddingLeft: 20 }}>{items}</ol>
        : <ul key={`l${key++}`} style={{ margin: '0 0 8px', paddingLeft: 20 }}>{items}</ul>,
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const bq = /^>\s?(.*)$/.exec(line);

    if (line.trim() === '') {
      flushPara(); flushList();
    } else if (h) {
      flushPara(); flushList();
      const level = h[1].length as 1 | 2 | 3;
      const Tag = (`h${level}`) as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={`h${key++}`} style={H_STYLE[level]}>{renderInline(h[2], `h${key}`)}</Tag>);
    } else if (bq) {
      flushPara(); flushList();
      blocks.push(
        <blockquote
          key={`q${key++}`}
          style={{
            margin: '0 0 8px',
            padding: '4px 10px',
            borderLeft: '2px solid var(--amber-line)',
            background: 'var(--amber-tint)',
            color: 'var(--caution-fg)',
            borderRadius: '0 4px 4px 0',
          }}
        >
          {renderInline(bq[1], `q${key}`)}
        </blockquote>,
      );
    } else if (ol) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push(ol[1]);
    } else if (ul) {
      flushPara();
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push(ul[1]);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();

  return (
    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
      {blocks}
    </div>
  );
}
