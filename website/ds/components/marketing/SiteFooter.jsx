import React from 'react';
import { Wordmark } from './Wordmark.jsx';
import { BoxedFrame } from '../core/BoxedFrame.jsx';
import { Input } from '../forms/Input.jsx';
import { IconButton } from '../core/IconButton.jsx';

export function SiteFooter({ blurb, columns = [], legal, meta = [], style, ...rest }) {
  return (
    <footer style={{ borderTop: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)',
      padding: 'var(--space-16) var(--space-6) var(--space-8)', ...style }} {...rest}>
      <div style={{ maxWidth: 'var(--container-max)', margin: '0 auto' }}>
        <BoxedFrame pad="var(--space-8)" style={{ marginBottom: 'var(--space-8)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 'var(--space-12)' }}>
            <div>
              <Wordmark style={{ marginBottom: 'var(--space-4)' }} />
              <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 'var(--lh-relaxed)' }}>{blurb}</p>
            </div>
            {columns.map(col => (
              <div key={col.title}>
                <h4 style={{ margin: '0 0 var(--space-4)', fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>{col.title}</h4>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  {col.links.map(l => (
                    <li key={l}><a href="#" className="ff-text-transition" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>{l}</a></li>
                  ))}
                </ul>
              </div>
            ))}
            <div>
              <h4 style={{ margin: '0 0 var(--space-4)', fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>Stay Updated</h4>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Input placeholder="Enter your email" style={{ borderRadius: 'var(--radius-sm)' }} />
                <IconButton icon="arrow-right" label="Subscribe" />
              </div>
            </div>
          </div>
        </BoxedFrame>
        <div style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 'var(--space-8)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-4)',
          fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          <p style={{ margin: 0 }}>{legal}</p>
          <div style={{ display: 'flex', gap: 'var(--space-6)' }}>
            {meta.map(m => <a key={m} href="#" className="ff-text-transition" style={{ color: 'var(--text-muted)' }}>{m}</a>)}
          </div>
        </div>
      </div>
    </footer>
  );
}
