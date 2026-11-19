// A decorative virtual pointer: no native mouse movement or focus change.
// The shadow tree isolates the artwork from the page's styles.
function cursorOverlay(command: 'install'|'move'|'hide'|'restore', x=0, y=0, click=false) {
  const install=()=>{
    let host=document.querySelector<HTMLElement>('[data-feno-pc-cursor]');
    if(host)return host;
    if(!document.documentElement)return null;
    host=document.createElement('div');
    host.setAttribute('data-feno-pc-cursor','');host.setAttribute('aria-hidden','true');
    host.style.cssText='all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;overflow:visible!important;pointer-events:none!important;z-index:2147483647!important;visibility:hidden!important';
    const shadow=host.attachShadow({mode:'open'});
    // No innerHTML or stylesheet injection: also works with Trusted Types/CSP.
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 25 32');svg.setAttribute('aria-hidden','true');
    svg.style.cssText='position:absolute;left:-3px;top:-2px;width:25px;height:32px;overflow:visible;filter:drop-shadow(0 1px 2px #0009);pointer-events:none';
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d','M3 2 L3 26 L10 19 L15 30 L20 27 L15 17 L24 17 Z');path.setAttribute('fill','#ff9500');path.setAttribute('stroke','#fff');path.setAttribute('stroke-width','2');path.setAttribute('stroke-linejoin','round');svg.append(path);
    const ring=document.createElement('div');ring.className='ring';ring.style.cssText='position:absolute;left:-18px;top:-18px;width:36px;height:36px;box-sizing:border-box;border:3px solid #ff9500;border-radius:50%;opacity:0;pointer-events:none';
    shadow.append(svg,ring);
    document.documentElement.append(host);return host;
  };
  if(window!==window.top)return;
  if(command==='install'&&!document.documentElement){document.addEventListener('DOMContentLoaded',install,{once:true});return;}
  const host=install();if(!host)return;
  if(command==='move'){
    host.style.setProperty('transform',`translate(${x}px,${y}px)`,'important');
    host.style.setProperty('visibility','visible','important');host.setAttribute('data-feno-positioned','');
    if(click){const ring=host.shadowRoot?.querySelector('.ring');ring?.getAnimations().forEach(a=>a.cancel());ring?.animate([{opacity:1,transform:'scale(.45)'},{opacity:0,transform:'scale(1.4)'}],{duration:500});}
  }else if(command==='hide')host.style.setProperty('visibility','hidden','important');
  else if(command==='restore'&&host.hasAttribute('data-feno-positioned'))host.style.setProperty('visibility','visible','important');
}

export function cursorExpression(command:'install'|'move'|'hide'|'restore',x=0,y=0,click=false){
  return `(${cursorOverlay.toString()})(${JSON.stringify(command)},${x},${y},${click})`;
}
