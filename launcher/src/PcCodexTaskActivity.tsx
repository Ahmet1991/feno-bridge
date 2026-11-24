import {useEffect,useState} from 'react';
import type {LauncherApi,PcCodexTaskActivity as Task} from './types';

export function PcCodexTaskActivity({api,onError}:{api:LauncherApi|undefined;onError:(error:string)=>void}){
  const [tasks,setTasks]=useState<Task[]>([]),[now,setNow]=useState(Date.now),[stopping,setStopping]=useState<string[]>([]);
  useEffect(()=>{
    if(!api)return;let alive=true;
    const refresh=()=>{void api.pcCodexTasks().then(value=>{if(alive){setTasks(value);setNow(Date.now());}}).catch(()=>{});};
    refresh();const timer=setInterval(refresh,2000);return()=>{alive=false;clearInterval(timer);};
  },[api]);
  if(!tasks.length)return null;
  return <section aria-label="Çalışan sohbet görevleri">
    <div className="section-heading activity-heading"><span>Çalışan sohbet görevleri</span></div>
    <div className="activity-table">{tasks.map(task=><div className="activity-row" key={task.taskId}>
      <div><strong>{task.title}</strong><span>{Math.max(0,Math.floor((now-task.startedAt)/1000))} sn · {task.subagentsStarted} alt ajan</span></div>
      <button type="button" disabled={stopping.includes(task.taskId)} onClick={()=>{
        setStopping(previous=>[...previous,task.taskId]);void api!.pcCodexTaskStop(task.taskId).catch(()=>{
          onError('Görev durdurma isteği yazılamadı.');setStopping(previous=>previous.filter(id=>id!==task.taskId));
        });
      }}>{stopping.includes(task.taskId)?'Durduruluyor…':'Durdur'}</button>
    </div>)}</div>
  </section>;
}
