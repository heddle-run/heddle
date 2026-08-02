import React from 'react';
export function Switch({checked,onChange,label,disabled}){
  return <label style={{display:'inline-flex',gap:10,alignItems:'center',fontFamily:'var(--font-sans)',cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.45:1}}>
    <span onClick={()=>!disabled&&onChange&&onChange(!checked)} style={{width:34,height:20,borderRadius:'var(--radius-pill)',background:checked?'var(--action-primary-bg)':'var(--border-strong)',padding:2,display:'flex',transition:'background-color var(--dur-fast) var(--ease-standard)'}}>
      <span style={{width:16,height:16,borderRadius:'50%',background:'#fff',transform:checked?'translateX(14px)':'none',transition:'transform var(--dur-fast) var(--ease-standard)',boxShadow:'0 1px 2px rgba(0,0,0,.2)'}}/>
    </span>
    {label&&<span style={{fontSize:14,color:'var(--text-strong)'}}>{label}</span>}
  </label>;
}