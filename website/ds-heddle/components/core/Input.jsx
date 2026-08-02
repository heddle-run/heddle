import React from 'react';
export function Input({label,hint,error,prefix,suffix,mono=false,size='md',style,...rest}){
  const h=size==='sm'?32:38;
  return <label style={{display:'grid',gap:6,fontFamily:'var(--font-sans)'}}>
    {label&&<span style={{fontSize:13,fontWeight:'var(--fw-medium)',color:'var(--text-strong)'}}>{label}</span>}
    <span style={{display:'flex',alignItems:'center',gap:8,height:h,padding:'0 10px',background:'var(--surface-raised)',border:`1px solid ${error?'var(--red-500)':'var(--border-default)'}`,borderRadius:'var(--radius-control)',boxShadow:'var(--shadow-xs)',transition:'var(--transition-control)'}}>
      {prefix&&<span style={{color:'var(--text-subtle)',fontFamily:'var(--font-mono)',fontSize:13}}>{prefix}</span>}
      <input style={{flex:1,border:'none',outline:'none',background:'transparent',font:'inherit',fontFamily:mono?'var(--font-mono)':'inherit',fontSize:14,color:'var(--text-strong)',...style}} {...rest}/>
      {suffix&&<span style={{color:'var(--text-subtle)',fontSize:13}}>{suffix}</span>}
    </span>
    {(hint||error)&&<span style={{fontSize:12.5,color:error?'var(--red-500)':'var(--text-muted)'}}>{error||hint}</span>}
  </label>;
}