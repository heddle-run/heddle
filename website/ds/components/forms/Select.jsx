'use client';
import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Select({ options = [], style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <div style={{ position: 'relative', ...style }}>
      <select
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        {...rest}
        style={{
          width: '100%', appearance: 'none', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-sm)',
          padding: 'var(--space-2) var(--space-8) var(--space-2) var(--space-3)',
          background: 'var(--bg-inset)', color: 'var(--text-strong)',
          border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', outline: 'none',
          boxShadow: focus ? '0 0 0 1px var(--brand-pink)' : 'none'
        }}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <span style={{ position: 'absolute', right: 12, top: 10, pointerEvents: 'none', color: 'var(--text-muted)' }}>
        <Icon name="chevron-down" size={14} />
      </span>
    </div>
  );
}
