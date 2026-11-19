const test = require('node:test');
const assert = require('node:assert/strict');
const { retryRuntimeStartup } = require('../electron/runtime-startup-retry.cjs');

test('startup retries a rejected upgrade, then succeeds and logs its reason', async () => {
  let attempts = 0;
  const events = [], waits = [];
  const result = await retryRuntimeStartup(async () => {
    if (++attempts === 1) throw new Error('CDP endpoint not ready');
    return { status: 'ready' };
  }, { onRetry: event => events.push(event), wait: async ms => waits.push(ms) });
  assert.deepEqual(result, { status: 'ready' });
  assert.deepEqual(waits, [5000]);
  assert.deepEqual(events, [{ attempt: 1, delayMs: 5000, message: 'CDP endpoint not ready' }]);
});

test('startup retries are bounded and cancellation prevents a later attempt', async () => {
  let attempts = 0;
  const fail = async () => { attempts++; throw new Error('failed'); };
  await assert.rejects(retryRuntimeStartup(fail, { wait: async () => {} }), /failed/);
  assert.equal(attempts, 4);
  const controller = new AbortController();
  attempts = 0;
  await assert.rejects(retryRuntimeStartup(fail, {
    signal: controller.signal, wait: async () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(attempts, 1);
});
