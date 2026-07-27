'use client';
import React from 'react';
import { Icon } from '../core/Icon.jsx';

/** 56×28 day/night switch: sky-to-gold gradient in light, midnight blue in dark,
 *  with an overshooting thumb carrying a sun/moon glyph. */
export function ThemeToggle({ dark = false, onToggle, style, ...rest }) {
  return (
    <button aria-label="Toggle theme" onClick={onToggle}
      style={{ position: 'relative', width: 56, height: 28, borderRadius: 14, cursor: 'pointer', border: 0,
        background: dark ? 'linear-gradient(135deg,#1a1a2e 0%,#16213e 100%)' : 'linear-gradient(135deg,#87ceeb 0%,#ffd700 100%)',
        boxShadow: dark
          ? 'inset 0 2px 4px rgba(0,0,0,.3),0 0 0 1px rgba(255,255,255,.1)'
          : 'inset 0 2px 4px rgba(0,0,0,.1),0 0 0 1px rgba(0,0,0,.05)',
        transition: 'all var(--dur-base) ease', ...style }} {...rest}>
      <span style={{ position: 'absolute', top: 2, left: dark ? 30 : 2, width: 24, height: 24, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: dark ? 'linear-gradient(135deg,#2d2d44 0%,#1a1a2e 100%)' : 'linear-gradient(135deg,#fff9c4 0%,#ffeb3b 100%)',
        boxShadow: dark ? '0 2px 8px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.1)' : '0 2px 8px rgba(255,193,7,.4),inset 0 1px 0 rgba(255,255,255,.8)',
        color: dark ? '#c7d2fe' : '#b45309',
        transition: 'all var(--dur-base) var(--ease-overshoot)' }}>
        <Icon name={dark ? 'moon' : 'sun'} size={14} />
      </span>
    </button>
  );
}
