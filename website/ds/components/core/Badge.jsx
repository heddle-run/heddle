import React from 'react';

export function Badge({ tone = 'accent', pulse = false, uppercase = false, beam = false, children, style, ...rest }) {
  const tones = {
    accent: { color: 'var(--brand-pink)', background: 'var(--brand-pink-05)', borderColor: 'var(--brand-pink-20)' },
    neutral: { color: 'var(--text-body)', background: 'var(--bg-sunken)', borderColor: 'var(--border-default)' },
    solid: { color: '#fff', background: 'var(--brand-pink)', borderColor: 'transparent' },
    gradient: { color: '#fff', background: 'linear-gradient(90deg,var(--brand-pink),var(--hue-rose))', borderColor: 'transparent' }
  }[tone];
  return (
    <span
      className={beam ? 'ff-tracing-beam' : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
        padding: uppercase ? '2px var(--space-2)' : '4px var(--space-3)',
        borderRadius: 'var(--radius-full)', border: '1px solid',
        fontSize: uppercase ? 'var(--fs-2xs)' : 'var(--fs-xs)',
        fontWeight: uppercase ? 'var(--fw-semibold)' : 'var(--fw-medium)',
        textTransform: uppercase ? 'uppercase' : 'none',
        letterSpacing: uppercase ? 'var(--tracking-widest)' : 'var(--tracking-normal)',
        ...tones, ...style }}
      {...rest}
    >
      {pulse && (
        <span style={{ position: 'relative', display: 'flex', width: 8, height: 8 }}>
          <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--brand-pink)', opacity: 0.75, animation: 'ff-ping 1s cubic-bezier(0,0,.2,1) infinite' }} />
          <span style={{ position: 'relative', width: 8, height: 8, borderRadius: '50%', background: 'var(--brand-pink)' }} />
        </span>
      )}
      {children}
    </span>
  );
}
