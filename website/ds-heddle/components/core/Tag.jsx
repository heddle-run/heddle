import React from 'react';
export function Tag({children,onRemove,style}){
  return <span style={{display:'inline-flex',alignItems:'center',gap:6,height:24,padding:'0 8px',borderRadius:'var(--radius-sm)',border:'1px solid var(--border-default)',background:'var(--surface-raised)',color:'var(--text-body)',fontFamily:'var(--font-mono)',fontSize:12,...style}}>
    {children}
    {onRemove&&<span onClick={onRemove} style={{cursor:'pointer',color:'var(--text-subtle)',fontSize:14,lineHeight:1}}>×</span>}
  </span>;
}