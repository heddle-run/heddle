'use client';
import React from 'react';
import { Icon } from './Icon.jsx';

export function IconButton({ icon, size = 'md', variant = 'solid', label, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const dim = size === 'sm' ? 28 : size === 'lg' ? 40 : 34;
  const looks = variant === 'solid'
    ? { background: hover ? 'var(--action-solid-bg-hover)' : 'var(--action-solid-bg)', color: 'var(--action-solid-fg)', border: '1px solid transparent' }
    : { background: hover ? 'var(--action-ghost-bg-hover)' : 'transparent', color: 'var(--text-body)', border: '1px solid var(--border-default)' };
  return (
    <button
      aria-label={label}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ width: dim, height: dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
        transition: 'background-color var(--dur-base) var(--ease-standard)', ...looks, ...style }}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 12 : 16} />
    </button>
  );
}
