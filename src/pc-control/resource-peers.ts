import type {PcPeerEvidence} from './resource-protocol';
import type {PcProfileId} from './types';
type ProcessInfo={state:string;startTime?:string};
export interface PcPeerRegistryOptions {
  directory:string;
  files:{ensurePrivateDirectory(path:string):void;writePrivateAtomic(path:string,bytes:Buffer|string):void;readPrivateFile(path:string,maxBytes:number):Buffer;inspectProcess?:(pid:number)=>ProcessInfo;inspectDevLauncherProcesses?:()=>{state:string;pids:number[]}};
  inspectProcess?:(pid:number)=>ProcessInfo;
  inspectDevLaunchers?:()=>{state:string;pids:number[]};retirementStore?:{read():boolean};
  legacyHomes?:Partial<Record<PcProfileId,string>>;devInstallPaths?:string[];clock?:()=>number;
}
export const createPcPeerRegistry=require('../../launcher/electron/pc-resource-peers.cjs').createPcPeerRegistry as
  (options:PcPeerRegistryOptions)=>{start(id:PcProfileId):void;heartbeat():void;close():void;observe():PcPeerEvidence;canRetireDev():boolean};
