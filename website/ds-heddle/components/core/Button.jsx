import React from 'react';
const SIZES={sm:{h:30,px:12,fs:13},md:{h:38,px:16,fs:14},lg:{h:46,px:22,fs:15}};
export function Button({variant='primary',size='md',disabled=false,fullWidth=false,iconLeft,iconRight,as='button',href,onClick,children,style,...rest}){
  const s=SIZES[size]||SIZES.md;
  const base={display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8,height:s.h,padding:`0 ${s.px}px`,fontFamily:'var(--font-sans)',fontSize:s.fs,fontWeight:'var(--fw-medium)',letterSpacing:'-0.005em',lineHeight:1,borderRadius:'var(--radius-control)',border:'1px solid transparent',cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.45:1,width:fullWidth?'100%':undefined,transition:'var(--transition-control)',textDecoration:'none',whiteSpace:'nowrap'};
  const V={
    primary:{background:'var(--action-primary-bg)',color:'var(--action-primary-fg)'},
    accent:{background:'var(--action-accent-bg)',color:'var(--action-accent-fg)'},
    secondary:{background:'var(--surface-raised)',color:'var(--text-strong)',borderColor:'var(--border-default)',boxShadow:'var(--shadow-xs)'},
    ghost:{background:'transparent',color:'var(--text-body)'},
    link:{background:'transparent',color:'var(--text-link)',height:'auto',padding:0}
  };
  const Tag=as==='a'?'a':'button';
  return <Tag href={href} onClick={disabled?undefined:onClick} disabled={Tag==='button'?disabled:undefined} style={{...base,...V[variant],...style}} {...rest}>{iconLeft}{children}{iconRight}</Tag>;
}