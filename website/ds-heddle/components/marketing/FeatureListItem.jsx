import React from 'react';
export function FeatureListItem({index,title,children,style}){
  return <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:16,padding:'18px 0',borderTop:'1px solid var(--border-hairline)',fontFamily:'var(--font-sans)',...style}}>
    <span style={{fontFamily:'var(--font-mono)',fontSize:12,color:'var(--text-subtle)',paddingTop:3}}>{index}</span>
    <div><div style={{fontSize:'var(--fs-h4)',fontWeight:'var(--fw-medium)',color:'var(--text-strong)',letterSpacing:'var(--ls-heading)'}}>{title}</div>
    <div style={{fontSize:14.5,color:'var(--text-muted)',lineHeight:1.62,marginTop:5,maxWidth:'62ch'}}>{children}</div></div>
  </div>;
}