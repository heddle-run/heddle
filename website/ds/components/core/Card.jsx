'use client';
import React from 'react';

export function Card({
  radius = '2xl', tone = 'card', pad = 'var(--space-8)', sheen = false, beam = false,
  hoverBorder = false, children, style, className = '', ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const tones = {
    card: { background: 'var(--surface-card)' },
    elevated: { background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-2xl)' },
    sunken: { background: 'var(--bg-sunken)' },
    glass: { background: 'var(--surface-chrome)', backdropFilter: 'blur(var(--blur-panel))' }
  }[tone];
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className={[sheen && 'ff-card-glow', beam && 'ff-tracing-beam', className].filter(Boolean).join(' ')}
      style={{
        position: 'relative', padding: pad,
        borderRadius: 'var(--radius-' + radius + ')',
        border: '1px solid ' + (hoverBorder && hover ? 'var(--border-strong)' : 'var(--border-default)'),
        transition: 'background-color var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard)',
        ...tones, ...style
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
