import {PcAuthorizer} from '../../src/pc-control/authorization';
import {acquirePcHostLease} from '../../src/pc-control/resource-locks';
const {getCurrentUserSid}=require('../../launcher/electron/private-acl-native.cjs');
const config=JSON.parse(process.argv[2]!);
const authorizer=new PcAuthorizer({profileId:config.profileId});
authorizer.setGrantFromLocalApproval({profileId:config.profileId,id:'child-grant-0001',expiresAt:Date.now()+60000,roots:[],permissions:['jobs'],allowedApps:[]});
const line=()=>new Promise<string>(resolve=>process.stdin.once('data',b=>resolve(b.toString().trim())));
console.log(JSON.stringify({state:'ready'}));
await line();
try {
  const lease=await acquirePcHostLease({...config,userSid:getCurrentUserSid(),authorizer,operation:'job',operationId:'child-operation-01',observePeers:()=>({complete:true,peers:[{profileId:'pc2-normal',verified:true,state:'active',protocol:'pc-host-control-v1'},{profileId:'pc2-dev',verified:true,state:'active',protocol:'pc-host-control-v1'}]})});
  console.log(JSON.stringify({state:'held',generation:lease.generation}));
  const command=await line();if(command==='crash')process.exit(17);
  await lease.releaseAfterExit(Promise.resolve());console.log(JSON.stringify({state:'released'}));process.exit(0);
}catch(error){console.log(JSON.stringify({error:(error as {code?:string}).code}));process.exit(2);}
