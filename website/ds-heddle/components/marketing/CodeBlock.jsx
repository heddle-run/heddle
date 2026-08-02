"use client";
import React from 'react';
export function CodeBlock({code='',language='yaml',filename,lines=[],copyable=true,style}){
  const src=lines.length?lines:String(code).split('\n');
  const [copied,setCopied]=React.useState(false);
  const color=(l)=>{
    if(/^\s*#/.test(l))return 'var(--code-comment)';
    return 'var(--code-fg)';
  };
  return <div style={{background:'var(--surface-code)',borderRadius:'var(--radius-card)',border:'1px solid var(--border-inverse)',overflow:'hidden',fontFamily:'var(--font-mono)',...style}}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'9px 12px',borderBottom:'1px solid var(--border-inverse)'}}>
      <span style={{fontSize:12,color:'var(--slate-400)'}}>{filename||language}</span>
      {copyable&&<button onClick={()=>{setCopied(true);setTimeout(()=>setCopied(false),1200);}} style={{background:'transparent',border:'1px solid var(--border-inverse)',borderRadius:'var(--radius-sm)',color:'var(--slate-300)',fontSize:11,fontFamily:'var(--font-mono)',padding:'3px 7px',cursor:'pointer'}}>{copied?'copied':'copy'}</button>}
    </div>
    <pre style={{margin:0,padding:'14px 16px',fontSize:'var(--fs-code)',lineHeight:'var(--lh-code)',overflowX:'auto'}}>{src.map((l,i)=><div key={i} style={{color:color(l),whiteSpace:'pre'}}>{l||' '}</div>)}</pre>
  </div>;
}