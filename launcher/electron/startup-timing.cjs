function createBootReporter(logger,{clock=Date.now,processStartedAt=Date.now()-Math.round(process.uptime()*1000)}={}){
  logger.info('launcher.boot_started',{processStartedAt:new Date(processStartedAt).toISOString(),elapsedMs:Math.max(0,clock()-processStartedAt),pid:process.pid});
  return {
    begin(phase){const started=clock();logger.info('launcher.boot_phase_started',{phase,elapsedMs:started-processStartedAt});
      return ()=>logger.info('launcher.boot_phase_finished',{phase,durationMs:Math.max(0,clock()-started),elapsedMs:clock()-processStartedAt});},
    wait(phase,reason,waitMs){logger.info('launcher.boot_wait',{phase,reason,waitMs,elapsedMs:clock()-processStartedAt});},
  };
}
module.exports={createBootReporter};
