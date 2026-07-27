import React from 'react';

export function Field({ label, hint, children, style, ...rest }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1-5)', ...style }} {...rest}>
      {label && (
        <label style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>
          {label}
        </label>
      )}
      {children}
      {hint && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{hint}</span>}
    </div>
  );
}
