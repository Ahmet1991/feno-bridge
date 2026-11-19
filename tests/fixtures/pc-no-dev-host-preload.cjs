// Test-only simulated Windows host. This file is passed explicitly to a child Bun
// process by the isolated end-to-end test; it is never imported by production.
'use strict';
const native=require('../../launcher/electron/private-acl.cjs');
const original=native.createPrivateFileAccess;
native.createPrivateFileAccess=(...args)=>Object.freeze({
  ...original(...args),
  inspectDevLauncherProcesses:()=>({state:'absent',pids:[]}),
});
