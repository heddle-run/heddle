import React from 'react';
export function Dialog({open=true,title,description,children,footer,onClose,width=480}){
  if(!open) return null;
  return <div style={{position:'fixed',inset:0,background:'rgba(11,10,9,.42)',backdropFilter:'blur(2px)',display:'grid',placeItems:'center',zIndex:50,fontFamily:'var(--font-sans)'}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{width,maxWidth:'92vw',background:'var(--surface-raised)',borderRadius:'var(--radius-panel)',boxShadow:'var(--shadow-lg)',padding:24}}>
      {title&&<div style={{fontSize:'var(--fs-h3)',fontWeight:'var(--fw-medium)',color:'var(--text-strong)',letterSpacing:'var(--ls-heading)'}}>{title}</div>}
      {description&&<div style={{fontSize:14,color:'var(--text-muted)',marginTop:6}}>{description}</div>}
      {children&&<div style={{marginTop:16,fontSize:14,color:'var(--text-body)'}}>{children}</div>}
      {footer&&<div style={{marginTop:20,display:'flex',justifyContent:'flex-end',gap:8}}>{footer}</div>}
    </div></div>;
}