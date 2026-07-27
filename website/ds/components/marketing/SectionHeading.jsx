'use client';
import React from 'react';

const HUES = ['var(--brand-pink)', 'var(--hue-purple)', 'var(--hue-blue)', 'var(--hue-emerald)', 'var(--hue-amber)'];

function Word({ text, hue }) {
  const [h, setH] = React.useState(false);
  return (
    <span className="ff-text-transition" onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ color: h ? hue : 'inherit', cursor: 'default' }}>{text}</span>
  );
}

export function SectionHeading({ words = [], sub, level = 2, align = 'center', style, ...rest }) {
  const size = level === 1 ? 'clamp(48px,7vw,96px)' : level === 2 ? 'clamp(30px,4vw,48px)' : 'var(--fs-3xl)';
  return (
    <div style={{ textAlign: align, maxWidth: align === 'center' ? 'var(--container-prose)' : undefined,
      margin: align === 'center' ? '0 auto' : undefined, ...style }} {...rest}>
      <h2 style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: '0 .28em',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        fontSize: size, fontWeight: level === 1 ? 'var(--fw-medium)' : 'var(--fw-semibold)',
        letterSpacing: level === 1 ? 'var(--tracking-tighter)' : 'var(--tracking-tight)',
        lineHeight: level === 1 ? 'var(--lh-tight)' : 'var(--lh-snug)', color: 'var(--text-strong)' }}>
        {words.map((w, i) => <Word key={i} text={w} hue={HUES[i % HUES.length]} />)}
      </h2>
      {sub && (
        <p style={{ margin: 'var(--space-4) auto 0', maxWidth: 'var(--container-prose)',
          fontSize: level === 1 ? 'var(--fs-lg)' : 'var(--fs-base)', color: 'var(--text-body)',
          lineHeight: 'var(--lh-relaxed)' }}>{sub}</p>
      )}
    </div>
  );
}
