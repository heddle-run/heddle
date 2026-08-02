import React from 'react';
const TONES={neutral:['var(--cloud-200)','var(--text-body)'],accent:['var(--blurple-100)','var(--blurple-700)'],teal:['var(--cyan-100)','var(--cyan-700)'],success:['var(--green-100)','var(--green-500)'],warning:['var(--amber-100)','var(--amber-500)'],danger:['var(--red-100)','var(--red-500)'],inverse:['var(--navy-900)','var(--cloud-100)']};
export function Badge({tone='neutral',mono=false,dot=false,children,style}){
  const [bg,fg]=TONES[tone]||TONES.neutral;
  return <span style={{display:'inline-flex',alignItems:'center',gap:6,height:22,padding:'0 9px',borderRadius:'var(--radius-pill)',background:bg,color:fg,fontSize:12,fontWeight:'var(--fw-medium)',fontFamily:mono?'var(--font-mono)':'var(--font-sans)',lineHeight:1,...style}}>
    {dot&&<span style={{width:5,height:5,borderRadius:'50%',background:'currentColor'}}/>}{children}</span>;
}