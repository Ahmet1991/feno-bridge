const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Electron switches are installed synchronously before the first startup await', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.slice(source.indexOf('async function start() {'));
  const firstAwait = start.indexOf('await ');
  for (const name of ['class', 'remote-debugging-address', 'remote-debugging-port']) {
    const index = start.indexOf(`app.commandLine.appendSwitch("${name}"`);
    assert.ok(index >= 0 && index < firstAwait, `${name} must precede the first await`);
  }
});
