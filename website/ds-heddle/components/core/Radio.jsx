import React from 'react';
export function Radio({label,description,checked,onChange,name,value,disabled}){
  return <label style={{display:'flex',gap:10,alignItems:'flex-start',fontFamily:'var(--font-sans)',cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.45:1}}>
    <span style={{width:16,height:16,marginTop:2,flex:'0 0 auto',borderRadius:'50%',border:`1px solid ${checked?'var(--action-primary-bg)':'var(--border-strong)'}`,background:'var(--surface-raised)',display:'grid',placeItems:'center',transition:'var(--transition-control)'}}>
      {checked&&<span style={{width:8,height:8,borderRadius:'50%',background:'var(--action-primary-bg)'}}/>}
    </span>
    <input type="radio" name={name} value={value} checked={checked} onChange={onChange} disabled={disabled} style={{position:'absolute',opacity:0,width:0,height:0}}/>
    <span><span style={{fontSize:14,color:'var(--text-strong)'}}>{label}</span>{description&&<span style={{display:'block',fontSize:12.5,color:'var(--text-muted)'}}>{description}</span>}</span>
  </label>;
}