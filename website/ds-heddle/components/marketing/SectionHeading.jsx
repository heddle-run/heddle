import React from 'react';
export function SectionHeading({number,eyebrow,title,lede,align='left',style}){
  return <div style={{display:'grid',gap:14,maxWidth:align==='center'?'760px':'none',margin:align==='center'?'0 auto':undefined,textAlign:align,fontFamily:'var(--font-sans)',...style}}>
    {(number||eyebrow)&&<div style={{fontFamily:'var(--font-label)',fontVariantNumeric:'tabular-nums',fontWeight:'var(--fw-medium)',fontSize:'var(--fs-label)',letterSpacing:'var(--ls-label)',textTransform:'uppercase',color:'var(--text-accent)',display:'flex',gap:12,justifyContent:align==='center'?'center':'flex-start'}}>{number&&<span style={{color:'var(--text-subtle)'}}>{number}</span>}<span>{eyebrow}</span></div>}
    {title&&<h2 style={{fontSize:'var(--fs-h1)',fontWeight:'var(--fw-light)',letterSpacing:'var(--ls-heading)',lineHeight:'var(--lh-heading)',color:'var(--text-strong)',margin:0}}>{title}</h2>}
    {lede&&<p style={{fontSize:'var(--fs-body-lg)',color:'var(--text-muted)',lineHeight:1.6,margin:0,maxWidth:'52ch'}}>{lede}</p>}
  </div>;
}