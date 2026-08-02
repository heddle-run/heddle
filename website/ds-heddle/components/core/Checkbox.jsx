import React from 'react';
export function Checkbox({label,description,checked,onChange,disabled,...rest}){
  return <label style={{display:'flex',gap:10,alignItems:'flex-start',fontFamily:'var(--font-sans)',cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.45:1}}>
    <span style={{width:16,height:16,marginTop:2,flex:'0 0 auto',borderRadius:'var(--radius-sm)',border:`1px solid ${checked?'var(--action-primary-bg)':'var(--border-strong)'}`,background:checked?'var(--action-primary-bg)':'var(--surface-raised)',display:'grid',placeItems:'center',transition:'var(--transition-control)'}}>
      {checked&&<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--action-primary-fg, #fff)" strokeWidth="3.5"><path d="M20 6 9 17l-5-5"/></svg>}
    </span>
    <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} style={{position:'absolute',opacity:0,width:0,height:0}} {...rest}/>
    <span><span style={{fontSize:14,color:'var(--text-strong)'}}>{label}</span>{description&&<span style={{display:'block',fontSize:12.5,color:'var(--text-muted)'}}>{description}</span>}</span>
  </label>;
}