import React from 'react';
import { Icon } from './Icon.jsx';
export function IconButton({name='copy',variant='ghost',size=32,label,onClick,style}){
  const V={ghost:{background:'transparent',border:'1px solid transparent',color:'var(--text-muted)'},secondary:{background:'var(--surface-raised)',border:'1px solid var(--border-default)',color:'var(--text-body)',boxShadow:'var(--shadow-xs)'},inverse:{background:'transparent',border:'1px solid var(--border-inverse)',color:'var(--slate-300)'}};
  return <button aria-label={label||name} onClick={onClick} style={{width:size,height:size,display:'grid',placeItems:'center',borderRadius:'var(--radius-control)',cursor:'pointer',transition:'var(--transition-control)',...V[variant],...style}}><Icon name={name} size={Math.round(size*0.5)}/></button>;
}