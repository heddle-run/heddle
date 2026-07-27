'use client';
import React from 'react';

export function TemplateCard({ title, body, hue = 'var(--brand-pink)', preview, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div className="ff-card-glow ff-tracing-beam"
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ border: '1px solid ' + (hover ? hue : 'var(--border-default)'), borderRadius: 'var(--radius-xl)',
        background: 'var(--surface-subtle)', overflow: 'hidden', cursor: 'pointer',
        transition: 'border-color var(--dur-base) var(--ease-standard)', ...style }} {...rest}>
      <div style={{ height: 192, background: 'var(--bg-sunken)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 'var(--space-8)',
        transform: hover ? 'scale(1.05)' : 'none', transition: 'transform var(--dur-slower) var(--ease-standard)' }}>
        <div style={{ width: '100%', height: '100%', background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
          boxShadow: 'var(--shadow-sm)', padding: 'var(--space-4)', opacity: .8,
          display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {preview}
        </div>
      </div>
      <div style={{ padding: 'var(--space-5)', borderTop: '1px solid var(--border-default)' }}>
        <h4 className="ff-text-transition" style={{ margin: '0 0 4px', fontSize: 'var(--fs-base)',
          fontWeight: 'var(--fw-medium)', color: hover ? hue : 'var(--text-strong)' }}>{title}</h4>
        <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{body}</p>
      </div>
    </div>
  );
}
