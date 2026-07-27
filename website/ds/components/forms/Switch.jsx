'use client';
import React from 'react';

export function Switch({ checked, onChange, label, style, ...rest }) {
  const [inner, setInner] = React.useState(!!checked);
  const on = checked === undefined ? inner : checked;
  const toggle = () => { if (checked === undefined) setInner(!on); onChange && onChange(!on); };
  const track = (
    <span style={{ position: 'relative', width: 36, height: 20, borderRadius: 'var(--radius-full)',
      background: on ? 'var(--brand-pink)' : 'var(--border-strong)', flex: '0 0 auto',
      transition: 'background-color var(--dur-base) var(--ease-standard)' }}>
      <span style={{ position: 'absolute', top: 2, left: 2, width: 16, height: 16, borderRadius: '50%',
        background: '#fff', border: '1px solid rgba(0,0,0,.06)',
        transform: on ? 'translateX(16px)' : 'none',
        transition: 'transform var(--dur-base) var(--ease-standard)' }} />
    </span>
  );
  if (!label) return <button role="switch" aria-checked={on} onClick={toggle} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', ...style }} {...rest}>{track}</button>;
  return (
    <div onClick={toggle} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 'var(--space-4)', padding: 'var(--space-3)', cursor: 'pointer',
      border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)',
      background: 'var(--surface-subtle)', ...style }} {...rest}>
      <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>{label}</span>
      {track}
    </div>
  );
}
