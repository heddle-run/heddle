import React from 'react';
export function Select({label,hint,options=[],size='md',style,...rest}){
  const h=size==='sm'?32:38;
  return <label style={{display:'grid',gap:6,fontFamily:'var(--font-sans)'}}>
    {label&&<span style={{fontSize:13,fontWeight:'var(--fw-medium)',color:'var(--text-strong)'}}>{label}</span>}
    <select style={{height:h,padding:'0 30px 0 10px',fontSize:14,fontFamily:'inherit',color:'var(--text-strong)',background:"var(--surface-raised) url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237d766d' stroke-width='2'><path d='m6 9 6 6 6-6'/></svg>\") no-repeat right 10px center",border:'1px solid var(--border-default)',borderRadius:'var(--radius-control)',boxShadow:'var(--shadow-xs)',appearance:'none',cursor:'pointer',...style}} {...rest}>
      {options.map(o=>{const v=typeof o==='string'?o:o.value,l=typeof o==='string'?o:o.label;return <option key={v} value={v}>{l}</option>;})}
    </select>
    {hint&&<span style={{fontSize:12.5,color:'var(--text-muted)'}}>{hint}</span>}
  </label>;
}