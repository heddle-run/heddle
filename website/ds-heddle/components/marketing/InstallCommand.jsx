"use client";
import React from 'react';
export function InstallCommand({command='npm install -g @heddle-run/cli',style}){
  const [copied,setCopied]=React.useState(false);
  return <div style={{display:'inline-flex',alignItems:'center',gap:12,height:44,padding:'0 6px 0 14px',background:'var(--surface-code)',border:'1px solid var(--border-inverse)',borderRadius:'var(--radius-control)',fontFamily:'var(--font-mono)',fontSize:13.5,color:'var(--code-fg)',...style}}>
    <span style={{color:'var(--blurple-400)'}}>$</span><span>{command}</span>
    <button onClick={()=>{navigator.clipboard&&navigator.clipboard.writeText(command);setCopied(true);setTimeout(()=>setCopied(false),1200);}} style={{height:32,padding:'0 10px',background:'transparent',border:'1px solid var(--border-inverse)',borderRadius:'var(--radius-sm)',color:'var(--slate-300)',fontFamily:'var(--font-mono)',fontSize:11.5,cursor:'pointer'}}>{copied?'copied':'copy'}</button>
  </div>;
}