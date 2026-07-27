import React from 'react';
import { Badge } from '../core/Badge.jsx';

export function FormCard({ title, subtitle, selected = false, children, style, ...rest }) {
  return (
    <div className="ff-boxed" style={{ position: 'relative', width: '100%', maxWidth: 448,
      background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-xl)', padding: 'var(--space-8)', boxShadow: 'var(--shadow-2xl)', ...style }} {...rest}>
      {selected && (
        <>
          {['tl', 'tr', 'bl', 'br'].map(c => (
            <div key={c} className={'ff-corner ff-corner-' + c} style={{ width: 12, height: 12 }} />
          ))}
          <div style={{ position: 'absolute', inset: -1, border: '2px solid var(--brand-pink-50)',
            borderRadius: 'var(--radius-xl)', pointerEvents: 'none', opacity: .5 }} />
          <div style={{ position: 'absolute', top: -12, right: -12 }}>
            <Badge tone="solid" uppercase style={{ borderRadius: 'var(--radius-sm)' }}>Selected</Badge>
          </div>
        </>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {(title || subtitle) && (
          <div style={{ textAlign: 'center' }}>
            {title && <h3 style={{ margin: 0, fontSize: 'var(--fs-xl)', fontWeight: 'var(--fw-semibold)', letterSpacing: 'var(--tracking-tight)', color: 'var(--text-strong)' }}>{title}</h3>}
            {subtitle && <p style={{ margin: '4px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>{subtitle}</p>}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>{children}</div>
      </div>
    </div>
  );
}
