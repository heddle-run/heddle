"use client";
import React from 'react';
export function Tabs({tabs=[],value,onChange,variant='underline'}){
  const active=value??(tabs[0]&&(tabs[0].value||tabs[0]));
  return <div style={{display:'flex',gap:variant==='underline'?22:4,borderBottom:variant==='underline'?'1px solid var(--border-hairline)':'none',fontFamily:'var(--font-sans)'}}>
    {tabs.map(t=>{const v=t.value||t,l=t.label||t,on=v===active;
      const under={padding:'0 0 10px',borderBottom:`2px solid ${on?'var(--blurple-500)':'transparent'}`,marginBottom:-1,color:on?'var(--text-strong)':'var(--text-muted)'};
      const pill={padding:'6px 12px',borderRadius:'var(--radius-control)',background:on?'var(--cloud-200)':'transparent',color:on?'var(--text-strong)':'var(--text-muted)'};
      return <button key={v} onClick={()=>onChange&&onChange(v)} style={{border:'none',background:'transparent',cursor:'pointer',font:'inherit',fontSize:14,fontWeight:on?'var(--fw-medium)':'var(--fw-regular)',transition:'var(--transition-control)',...(variant==='underline'?under:pill)}}>{l}</button>;})}
  </div>;
}