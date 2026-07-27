'use client';
import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Button } from '../core/Button.jsx';
import { Badge } from '../core/Badge.jsx';

export function PricingCard({ name, price, period = '/mo', blurb, features = [], cta, featured = false, hue = 'var(--brand-pink)', style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div className={featured ? 'ff-boxed ff-gradient-border ff-border-glow' : 'ff-boxed ff-tracing-beam'}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column',
        padding: 'var(--space-8)', borderRadius: 'var(--radius-2xl)',
        background: featured ? 'var(--bg-elevated)' : 'var(--surface-subtle)',
        border: featured ? undefined : '1px solid var(--border-default)',
        boxShadow: featured ? 'var(--shadow-2xl)' : 'none',
        transform: featured ? 'scale(1.05)' : 'none', zIndex: featured ? 10 : 1, ...style }} {...rest}>
      {(featured ? ['tl', 'tr', 'bl', 'br'] : ['tl', 'br']).map(c => <div key={c} className={'ff-corner ff-corner-' + c} />)}
      {featured && (
        <div style={{ position: 'absolute', top: -16, left: '50%', transform: 'translateX(-50%)' }}>
          <Badge tone="gradient" uppercase>Most Popular</Badge>
        </div>
      )}
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <h3 className="ff-text-transition" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
          style={{ margin: 0, fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-medium)', color: hover ? hue : 'var(--text-strong)' }}>{name}</h3>
        <div style={{ marginTop: 'var(--space-2)', display: 'flex', alignItems: 'baseline', gap: 4 }}>
          <span style={{ fontSize: 'var(--fs-4xl)', fontWeight: 'var(--fw-semibold)',
            letterSpacing: 'var(--tracking-tight)', color: 'var(--text-strong)' }}>{price}</span>
          <span style={{ color: 'var(--text-muted)' }}>{period}</span>
        </div>
      </div>
      <p style={{ margin: '0 0 var(--space-6)', fontSize: 'var(--fs-sm)', color: 'var(--text-body)' }}>{blurb}</p>
      <ul style={{ listStyle: 'none', margin: '0 0 var(--space-8)', padding: 0, flex: 1,
        display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {features.map(t => (
          <li key={t} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
            fontSize: 'var(--fs-sm)', color: featured ? 'var(--text-strong)' : 'var(--text-body)' }}>
            <Icon name="check" size={16} color={featured ? 'var(--brand-pink)' : 'var(--text-faint)'} />
            {t}
          </li>
        ))}
      </ul>
      <Button block shape="rounded" variant={featured ? 'solid' : 'subtle'}>{cta}</Button>
    </div>
  );
}
