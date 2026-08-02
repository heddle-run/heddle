"use client";
import React from 'react';
export function Tooltip({label,side='top',children}){
  const [on,setOn]=React.useState(false);
  const pos=side==='top'?{bottom:'calc(100% + 6px)',left:'50%',transform:'translateX(-50%)'}:{top:'calc(100% + 6px)',left:'50%',transform:'translateX(-50%)'};
  return <span style={{position:'relative',display:'inline-flex'}} onMouseEnter={()=>setOn(true)} onMouseLeave={()=>setOn(false)}>
    {children}
    {on&&<span style={{position:'absolute',...pos,whiteSpace:'nowrap',background:'var(--surface-inverse)',color:'var(--text-inverse)',fontSize:12,fontFamily:'var(--font-sans)',padding:'5px 8px',borderRadius:'var(--radius-sm)',boxShadow:'var(--shadow-md)',zIndex:20,pointerEvents:'none'}}>{label}</span>}
  </span>;
}