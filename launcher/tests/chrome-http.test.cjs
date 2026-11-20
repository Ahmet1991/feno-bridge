const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

test('page operations initialize and keep document identity on HTTP without randomUUID', async () => {
  const {pageOperation} = await import('../chrome-extension/dom.js');
  const context = vm.createContext({
    crypto: {getRandomValues: webcrypto.getRandomValues.bind(webcrypto)},
    document: {body: {innerText: 'Router status'}, querySelectorAll: () => []},
  });
  const run = args => vm.runInContext(`(${pageOperation.toString()})('read', ${JSON.stringify(args)})`, context);
  const first = run({mode: 'text'});
  assert.equal(first.text, 'Router status');
  assert.equal(typeof first.documentId, 'string');
  assert.ok(first.documentId.length >= 32);
  assert.equal(run({mode: 'tree'}).documentId, first.documentId);
  vm.runInContext('delete globalThis.__fenoPc2State', context);
  assert.notEqual(run({mode: 'text'}).documentId, first.documentId);
});
