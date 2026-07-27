import React from 'react';

export function Marquee({ eyebrow, speed = 26, children, style, ...rest }) {
  const items = React.Children.toArray(children);
  return (
    <div style={{ position: 'relative', overflow: 'hidden', ...style }} {...rest}>
      {eyebrow && (
        <p className="ff-text-transition" style={{ margin: '0 0 var(--space-8)', textAlign: 'center',
          fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-widest)', fontWeight: 'var(--fw-medium)' }}>{eyebrow}</p>
      )}
      <div style={{ position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', zIndex: 10, left: 0, top: 0, bottom: 0, width: 96,
          background: 'linear-gradient(90deg,var(--bg-sunken),transparent)' }} />
        <div style={{ position: 'absolute', zIndex: 10, right: 0, top: 0, bottom: 0, width: 96,
          background: 'linear-gradient(270deg,var(--bg-sunken),transparent)' }} />
        <div style={{ display: 'flex', gap: 'var(--space-4)', width: 'max-content',
          animation: 'ff-marquee ' + speed + 's linear infinite' }}>
          {[0, 1].map(dup => (
            <div key={dup} style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>{items}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
