function bindTunnelWake(powerMonitor, check) {
  let active=false, disposed=false;
  const trigger=event=>{
    if(active||disposed)return;
    active=true;
    try{Promise.resolve(check(event)).catch(()=>{}).finally(()=>{active=false;});}
    catch{active=false;}
  };
  const resume=()=>trigger('resume'),unlock=()=>trigger('unlock-screen');
  powerMonitor.on('resume',resume);powerMonitor.on('unlock-screen',unlock);
  return ()=>{disposed=true;powerMonitor.removeListener('resume',resume);powerMonitor.removeListener('unlock-screen',unlock);};
}
module.exports={bindTunnelWake};
