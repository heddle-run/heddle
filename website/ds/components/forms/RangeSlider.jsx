'use client';
import React from 'react';

export function RangeSlider({ value, min = 0, max = 100, onChange, readout, style, ...rest }) {
  const [inner, setInner] = React.useState(value ?? 50);
  const v = value === undefined ? inner : value;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', ...style }}>
      <input
        type="range" min={min} max={max} value={v}
        onChange={e => { const n = Number(e.target.value); if (value === undefined) setInner(n); onChange && onChange(n); }}
        {...rest}
        style={{ width: '100%', height: 4, appearance: 'none', borderRadius: 'var(--radius-xs)',
          background: 'linear-gradient(90deg,var(--brand-pink) ' + ((v - min) / (max - min) * 100) + '%,var(--border-strong) ' + ((v - min) / (max - min) * 100) + '%)',
          cursor: 'pointer', outline: 'none' }}
      />
      {readout !== undefined && (
        <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-strong)', whiteSpace: 'nowrap' }}>{readout}</span>
      )}
    </div>
  );
}
