'use client';
import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function StepCard({ icon, title, body, hue = 'var(--brand-pink)', style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', position: 'relative', ...style }} {...rest}>
      <div className="ff-tracing-beam" style={{ width: 96, height: 96, borderRadius: 'var(--radius-2xl)',
        background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 'var(--space-6)',
        boxShadow: 'var(--shadow-lg)', color: 'var(--text-strong)', zIndex: 2 }}>
        <Icon name={icon} size={40} />
      </div>
      <h3 className="ff-text-transition" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-xl)', fontWeight: 'var(--fw-medium)',
          color: hover ? hue : 'var(--text-strong)' }}>{title}</h3>
      <p style={{ margin: 0, padding: '0 var(--space-4)', fontSize: 'var(--fs-sm)', color: 'var(--text-body)' }}>{body}</p>
    </div>
  );
}
