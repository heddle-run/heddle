import React from 'react';

/** The signature FormFlow wrapper: pink corner ticks, optional 1px rules that
 *  extend off-screen, and an optional beam streak along the top edge. */
export function BoxedFrame({
  corners = 'all', edges = 'all', beam = false, pad = 0, children, style, className = '', ...rest
}) {
  const cornerList = corners === 'all' ? ['tl', 'tr', 'bl', 'br']
    : corners === 'diagonal' ? ['tl', 'br'] : corners === 'none' ? [] : corners;
  const edgeList = edges === 'all' ? ['top', 'bottom', 'left', 'right']
    : edges === 'horizontal' ? ['top', 'bottom'] : edges === 'none' ? [] : edges;
  const delays = { top: '0s', bottom: '.3s', left: '.15s', right: '.45s' };
  return (
    <div className={'ff-boxed ' + className} style={{ padding: pad, ...style }} {...rest}>
      {edgeList.map(e => (
        <div key={e} className={'ff-edge ff-edge-' + e} style={{ animationDelay: delays[e] }} />
      ))}
      {cornerList.map(c => <div key={c} className={'ff-corner ff-corner-' + c} />)}
      {beam && <div className="ff-beam-runner" style={{ top: 0 }} />}
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  );
}
