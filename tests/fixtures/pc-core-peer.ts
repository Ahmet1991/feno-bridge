// Isolated test participant, never invoked by product code.
import {createPcPeerRegistry} from '../../src/pc-control/resource-peers';
const native=require('../../launcher/electron/private-acl-native.cjs');
const files=require('../../launcher/electron/private-acl.cjs').createPrivateFileAccess(native.getCurrentUserSid());
const registry=createPcPeerRegistry({directory:process.argv[2]!,files});
registry.start('pc2-dev');registry.close();
