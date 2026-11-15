"use strict";
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
function retrySharingViolation(operation,{sleep:pause=sleep}={}){
  const waits=[20,35,50,65]; // Four pauses, 170 ms total; five attempts.
  for(let attempt=0;attempt<=waits.length;attempt++){
    try{return operation();}
    catch(error){
      if(![32,33].includes(error?.nativeCode)||attempt===waits.length)throw error;
      pause(waits[attempt]);
    }
  }
}
module.exports={retrySharingViolation};
