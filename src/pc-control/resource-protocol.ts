import {PcOperationError} from './errors';
export const PC_RESOURCE_PROTOCOL='pc-host-control-v1';
export interface PcPeerEvidence {
  complete:boolean;
  peers:Array<{profileId:string;verified:boolean;state:string;protocol?:string;reason?:'not-installed'|'retired'|'running'}>;
}
/** Host-supplied discovery evidence, never model arguments. Missing evidence is not an idle peer. */
export function assertCompatiblePcResourcePeers(evidence:PcPeerEvidence|undefined):void {
  const deny=()=>{throw new PcOperationError('pc_resource_coordination_required');};
  if(!evidence||evidence.complete!==true||!Array.isArray(evidence.peers)||evidence.peers.length!==2)deny();
  const expected=new Set(['pc2-normal','pc2-dev']);
  for(const peer of evidence!.peers){
    if(!peer||!expected.delete(peer.profileId)||peer.verified!==true||!['active','inactive'].includes(peer.state))deny();
    if(peer.state==='active'&&peer.protocol!==PC_RESOURCE_PROTOCOL)deny();
  }
  if(expected.size)deny();
}
