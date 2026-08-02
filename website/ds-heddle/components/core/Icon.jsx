import React from 'react';
const P={
 terminal:['m4 17 6-6-6-6','M12 19h8'],copy:['M8 8m0 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z','M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2'],check:['M20 6 9 17l-5-5'],arrowRight:['M5 12h14','m12 5 7 7-7 7'],shield:['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'],
 file:['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z','M14 2v5h5'],zap:['M4 14h7l-2 8 11-12h-7l2-8z'],github:['M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4','M9 18c-4.51 2-5-2-7-2'],chevronDown:['m6 9 6 6 6-6'],x:['M18 6 6 18','m6 6 12 12'],menu:['M4 6h16','M4 12h16','M4 18h16']};
export function Icon({name='check',size=16,strokeWidth=1.5,color='currentColor',style}){
  const d=P[name]||P.check;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{flex:'0 0 auto',...style}} aria-hidden="true">{d.map((p,i)=><path key={i} d={p}/>)}</svg>;
}