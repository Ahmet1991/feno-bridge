const { setTimeout: delay } = require('node:timers/promises');

async function retryRuntimeStartup(start, { onRetry, signal, delays = [5000, 15000, 60000], wait = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await start(); }
    catch (error) {
      if (signal?.aborted || attempt >= delays.length) throw error;
      const delayMs = delays[attempt];
      onRetry?.({ attempt: attempt + 1, delayMs, message: error instanceof Error ? error.message : String(error) });
      await wait(delayMs, undefined, { signal });
    }
  }
}

module.exports = { retryRuntimeStartup };
