import React from 'react';

/** The three-layer FormFlow page background: blurred conic swirls, a 50px grid,
 *  and a fixed fractal-noise film on top. Render once, first in <body>. */
export function Backdrop({ swirls = true, grid = true, noise = true, style, ...rest }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden', ...style }} {...rest}>
      {swirls && (
        <>
          <div className="ff-swirl" style={{ top: '-20%', left: '-10%', width: 600, height: 600, background: 'var(--swirl-1)' }} />
          <div className="ff-swirl" style={{ top: '40%', right: '-15%', width: 400, height: 400, background: 'var(--swirl-2)', animationDelay: '-5s' }} />
          <div className="ff-swirl" style={{ bottom: '-20%', left: '30%', width: 500, height: 500, background: 'var(--swirl-3)', animationDelay: '-10s' }} />
        </>
      )}
      {grid && <div className="ff-grid-pattern" style={{ position: 'absolute', inset: 0, opacity: .5 }} />}
      {noise && <div className="ff-noise" style={{ zIndex: 50 }} />}
    </div>
  );
}
