import React from 'react';
export function Card({title,eyebrow,children,footer,interactive=false,padding=20,style}){
  return <div style={{background:'var(--surface-card)',border:'1px solid var(--border-hairline)',borderRadius:'var(--radius-card)',boxShadow:'var(--shadow-xs)',padding,fontFamily:'var(--font-sans)',transition:'var(--transition-control)',cursor:interactive?'pointer':undefined,...style}}>
    {eyebrow&&<div style={{fontFamily:'var(--font-mono)',fontSize:'var(--fs-label)',letterSpacing:'var(--ls-label)',textTransform:'uppercase',color:'var(--text-accent)',marginBottom:10}}>{eyebrow}</div>}
    {title&&<div style={{fontSize:'var(--fs-h4)',fontWeight:'var(--fw-medium)',color:'var(--text-strong)',letterSpacing:'var(--ls-heading)',marginBottom:6}}>{title}</div>}
    <div style={{fontSize:14,color:'var(--text-body)',lineHeight:1.6}}>{children}</div>
    {footer&&<div style={{marginTop:14,paddingTop:12,borderTop:'1px solid var(--border-hairline)',fontSize:13,color:'var(--text-muted)'}}>{footer}</div>}
  </div>;
}