import React from 'react';
export function Terminal({lines=[],title='zsh',style}){
  return <div style={{background:'var(--surface-terminal, var(--navy-900))',borderRadius:'var(--radius-card)',border:'1px solid var(--border-inverse)',overflow:'hidden',fontFamily:'var(--font-mono)',...style}}>
    <div style={{display:'flex',alignItems:'center',gap:6,padding:'9px 12px',borderBottom:'1px solid var(--border-inverse)'}}>
      {['#2b5479','#2b5479','#2b5479'].map((c,i)=><span key={i} style={{width:9,height:9,borderRadius:'50%',background:c}}/>)}
      <span style={{fontSize:11.5,color:'var(--slate-400)',marginLeft:8}}>{title}</span>
    </div>
    <div style={{padding:'14px 16px',fontSize:'var(--fs-code)',lineHeight:1.75}}>
      {lines.map((l,i)=>{const t=typeof l==='string'?{text:l}:l;
        const c=t.kind==='prompt'?'var(--code-fg)':t.kind==='tool'?'var(--blurple-300)':t.kind==='ok'?'var(--cyan-300)':t.kind==='dim'?'var(--slate-400)':'var(--slate-200)';
        return <div key={i} style={{color:c,whiteSpace:'pre-wrap'}}>{t.kind==='prompt'&&<span style={{color:'var(--blurple-400)'}}>$ </span>}{t.text}</div>;})}
    </div></div>;
}