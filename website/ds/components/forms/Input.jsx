'use client';
import React from 'react';

export function Input({ size = 'md', invalid = false, style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <input
      onFocus={e => { setFocus(true); rest.onFocus && rest.onFocus(e); }}
      onBlur={e => { setFocus(false); rest.onBlur && rest.onBlur(e); }}
      {...rest}
      style={{
        width: '100%', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-sm)',
        padding: size === 'sm' ? '6px var(--space-3)' : 'var(--space-2) var(--space-3)',
        background: 'var(--bg-inset)', color: 'var(--text-strong)',
        border: '1px solid ' + (invalid ? 'var(--brand-pink)' : 'var(--border-default)'),
        borderRadius: 'var(--radius-lg)', outline: 'none',
        boxShadow: focus ? '0 0 0 1px var(--brand-pink)' : 'none',
        transition: 'box-shadow var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard)',
        ...style
      }}
    />
  );
}
