'use client';
import React from 'react';
import { Wordmark } from './Wordmark.jsx';
import { Button } from '../core/Button.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';

export function NavBar({ links = [], cta = 'Start Building', onToggleTheme, dark, style, ...rest }) {
  return (
    <nav style={{ position: 'sticky', top: 0, zIndex: 50, width: '100%',
      borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-chrome)',
      backdropFilter: 'blur(var(--blur-chrome))', ...style }} {...rest}>
      <div style={{ maxWidth: 'var(--container-max)', margin: '0 auto', padding: '0 var(--space-6)',
        height: 'var(--nav-height)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Wordmark />
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)',
          fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>
          {links.map(l => (
            <a key={l.label} href={l.href} className="ff-text-transition" style={{ color: 'var(--text-body)' }}>{l.label}</a>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
          <ThemeToggle dark={dark} onToggle={onToggleTheme} />
          <a href="#" className="ff-text-transition" style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-body)' }}>Log in</a>
          <Button size="sm" beam>{cta}</Button>
        </div>
      </div>
    </nav>
  );
}
