import React from 'react';
import { Icon } from '../core/Icon.jsx';

/** No logo file was supplied with the source design — the wordmark is the
 *  lucide "layers" glyph beside the name set in Inter Medium, all caps.
 *
 *  NOTE: vendored for fidelity but UNUSED by this site — it renders the literal
 *  string FORMFLOW. heddle's own lockup is components/Wordmark.tsx, built in the
 *  same idiom. See ds/DEVIATIONS.md. */
export function Wordmark({ size = 'md', style, ...rest }) {
  const fs = size === 'sm' ? 'var(--fs-sm)' : size === 'lg' ? 'var(--fs-xl)' : 'var(--fs-lg)';
  return (
    <div className="ff-text-transition" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
      color: 'var(--text-strong)', fontWeight: 'var(--fw-medium)', letterSpacing: 'var(--tracking-tight)',
      fontSize: fs, ...style }} {...rest}>
      <Icon name="layers" size={20} />
      <span>FORMFLOW</span>
    </div>
  );
}
