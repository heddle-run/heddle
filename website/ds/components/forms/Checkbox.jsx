'use client';
import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Checkbox({ checked, onChange, label, style, ...rest }) {
  const [inner, setInner] = React.useState(!!checked);
  const on = checked === undefined ? inner : checked;
  const toggle = () => { if (checked === undefined) setInner(!on); onChange && onChange(!on); };
  return (
    <label onClick={toggle} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)',
      fontSize: 'var(--fs-sm)', color: 'var(--text-strong)', cursor: 'pointer', ...style }} {...rest}>
      <span style={{ width: 16, height: 16, borderRadius: 'var(--radius-sm)', flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
        background: on ? 'var(--brand-pink)' : 'var(--bg-inset)',
        border: '1px solid ' + (on ? 'var(--brand-pink)' : 'var(--border-strong)'),
        transition: 'background-color var(--dur-fast) var(--ease-standard)' }}>
        {on && <Icon name="check" size={12} />}
      </span>
      {label}
    </label>
  );
}
