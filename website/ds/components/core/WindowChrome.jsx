import React from 'react';

const dots = [
  { bg: 'rgba(239,68,68,.2)', bd: 'rgba(239,68,68,.5)' },
  { bg: 'rgba(234,179,8,.2)', bd: 'rgba(234,179,8,.5)' },
  { bg: 'rgba(34,197,94,.2)', bd: 'rgba(34,197,94,.5)' }
];

export function WindowChrome({ beam = true, children, style, ...rest }) {
  return (
    <div
      style={{ position: 'relative', borderRadius: 'var(--radius-xl)', overflow: 'hidden',
        background: 'var(--bg-elevated)', backdropFilter: 'blur(var(--blur-panel))',
        border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-window)', ...style }}
      {...rest}
    >
      <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
        padding: '0 var(--space-4)', position: 'relative',
        borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-panel)' }}>
        {dots.map((d, i) => (
          <div key={i} style={{ width: 12, height: 12, borderRadius: '50%', background: d.bg, border: '1px solid ' + d.bd }} />
        ))}
        {beam && <div className="ff-beam-runner" style={{ top: '50%', height: 2 }} />}
      </div>
      {children}
    </div>
  );
}
