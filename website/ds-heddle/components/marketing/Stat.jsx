import React from 'react';
export function Stat({value,label,note,align='left'}){
  return <div style={{textAlign:align,fontFamily:'var(--font-sans)'}}>
    <div style={{fontFamily:'var(--font-mono)',fontSize:44,lineHeight:1,color:'var(--text-strong)',letterSpacing:'-0.03em'}}>{value}</div>
    <div style={{fontSize:14,color:'var(--text-body)',marginTop:10}}>{label}</div>
    {note&&<div style={{fontSize:12.5,color:'var(--text-subtle)',marginTop:3}}>{note}</div>}
  </div>;
}