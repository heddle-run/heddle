'use client';
import React from 'react';
import { Icon } from './Icon.jsx';

const base = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)',
  fontFamily: 'var(--font-sans)', fontWeight: 'var(--fw-medium)', cursor: 'pointer',
  border: '1px solid transparent', whiteSpace: 'nowrap',
  transition: 'background-color var(--dur-base) var(--ease-standard), color var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard)'
};
const sizes = {
  sm: { height: 32, padding: '0 var(--space-3)', fontSize: 'var(--fs-xs)' },
  md: { height: 40, padding: '0 var(--space-5)', fontSize: 'var(--fs-sm)' },
  lg: { height: 48, padding: '0 var(--space-8)', fontSize: 'var(--fs-base)' }
};

export function Button({
  variant = 'solid', size = 'md', shape = 'pill', icon, iconAfter,
  beam = false, block = false, disabled = false, children, style, className = '', ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const looks = {
    solid: {
      background: hover ? 'var(--action-solid-bg-hover)' : 'var(--action-solid-bg)',
      color: 'var(--action-solid-fg)'
    },
    outline: {
      background: hover ? 'var(--action-ghost-bg-hover)' : 'var(--action-ghost-bg)',
      color: 'var(--text-strong)', borderColor: 'var(--border-strong)'
    },
    subtle: {
      background: hover ? 'var(--surface-card-hover)' : 'var(--bg-sunken)',
      color: 'var(--text-strong)', borderColor: 'var(--border-default)'
    },
    ghost: {
      background: hover ? 'var(--action-ghost-bg-hover)' : 'transparent',
      color: hover ? 'var(--text-strong)' : 'var(--text-body)'
    },
    accent: {
      background: 'var(--brand-pink)', color: '#fff',
      filter: hover ? 'brightness(1.08)' : 'none'
    }
  }[variant];

  return (
    <button
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={(beam ? 'ff-tracing-beam ' : '') + className}
      style={{
        ...base, ...sizes[size], ...looks,
        borderRadius: shape === 'pill' ? 'var(--radius-full)' : 'var(--radius-lg)',
        width: block ? '100%' : undefined,
        opacity: disabled ? 0.4 : 1, pointerEvents: disabled ? 'none' : undefined,
        ...style
      }}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
      {iconAfter && (
        <span style={{ display: 'inline-flex', transform: hover ? 'translateX(4px)' : 'none', transition: 'transform var(--dur-base) var(--ease-standard)' }}>
          <Icon name={iconAfter} size={size === 'sm' ? 14 : 16} />
        </span>
      )}
    </button>
  );
}
