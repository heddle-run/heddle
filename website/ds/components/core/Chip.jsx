'use client';
import React from 'react';
import { Icon } from './Icon.jsx';

export function Chip({ icon, accent = 'var(--brand-pink)', children, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className="ff-text-transition"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
        padding: 'var(--space-2) var(--space-4)', background: 'var(--surface-card)',
        border: '1px solid ' + (hover ? accent : 'var(--border-default)'),
        borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-sm)', color: 'var(--text-strong)',
        whiteSpace: 'nowrap', ...style }}
      {...rest}
    >
      {icon && <Icon name={icon} size={16} color={accent} />}
      {children}
    </div>
  );
}
