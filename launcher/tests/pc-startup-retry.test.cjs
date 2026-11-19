const test = require('node:test');
const assert = require('node:assert/strict');
const { createPcStartupRetry } = require('../electron/pc-startup-retry.cjs');

test('PC startup retries after a transient security initialization failure', () => {
  let attempts = 0;
  const timers = [];
  const failures = [];
  const retry = createPcStartupRetry({
    start() { if (++attempts === 1) throw Object.assign(new Error('private path'), { code: 'EACCES' }); },
    onFailure(error) { failures.push(error); },
    schedule(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    cancel() {},
  });
  retry.start();
  assert.equal(attempts, 1);
  assert.equal(timers[0].delay, 5000);
  assert.deepEqual(failures[0], { errorClass: 'Error', code: 'EACCES' });
  timers.shift().fn();
  assert.equal(attempts, 2);
  assert.equal(timers.length, 0);
});
