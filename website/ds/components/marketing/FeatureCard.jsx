'use client';
import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Card } from '../core/Card.jsx';

export function FeatureCard({ icon, hue = 'var(--brand-pink)', title, body, feature = false, glow = false, children, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <Card sheen hoverBorder={!feature} beam={!feature} radius="2xl" pad={0}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ overflow: 'hidden', ...style }} {...rest}>
      {glow && (
        <div style={{ position: 'absolute', right: -80, top: -80, width: 384, height: 384, borderRadius: '50%',
          background: hover ? 'var(--brand-pink-20)' : 'var(--brand-pink-10)', filter: 'blur(64px)',
          transition: 'background var(--dur-scale) var(--ease-standard)' }} />
      )}
      <div style={{ position: 'relative', zIndex: 2, padding: 'var(--space-8)', height: '100%',
        display: 'flex', flexDirection: 'column', justifyContent: feature ? 'flex-end' : 'flex-start' }}>
        {icon && (feature ? (
          <div style={{ width: 'fit-content', marginBottom: 'var(--space-4)', padding: 'var(--space-3)',
            background: 'var(--brand-pink-10)', border: '1px solid var(--brand-pink-20)',
            borderRadius: 'var(--radius-lg)', color: 'var(--brand-pink)' }}>
            <Icon name={icon} size={24} />
          </div>
        ) : (
          <span style={{ marginBottom: 'var(--space-6)', color: hue }}><Icon name={icon} size={32} /></span>
        ))}
        <h3 className="ff-text-transition" style={{ margin: '0 0 var(--space-2)',
          fontSize: feature ? 'var(--fs-2xl)' : 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)',
          color: hover ? hue : 'var(--text-strong)' }}>{title}</h3>
        <p style={{ margin: 0, fontSize: feature ? 'var(--fs-base)' : 'var(--fs-sm)',
          color: 'var(--text-body)', lineHeight: 'var(--lh-normal)' }}>{body}</p>
        {children}
      </div>
    </Card>
  );
}
