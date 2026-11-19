// Run Bun-dependent fixtures separately from Node's test workers. On Windows,
// Node spawning Bun can trigger Defender's SuspBunActivity behavior rule.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (!process.versions.bun) throw new Error('Run launcher tests with Bun');
const cwd = path.resolve(__dirname, '..');
const bunTests = new Set([
  'runtime-install.test.cjs', 'pc-settings.test.cjs', 'private-acl.test.cjs',
  'pc-service.test.cjs', 'pc-security-store.test.cjs', 'pc-full-access.test.cjs',
]);
const files = fs.readdirSync(path.join(cwd, 'tests')).filter(name => name.endsWith('.test.cjs')).sort();
const run = (executable, args) => {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
};
const nodeStatus = run('node', ['--test', ...files.filter(name => !bunTests.has(name)).map(name => `tests/${name}`)]);
const bunStatus = run(process.execPath, ['test', ...files.filter(name => bunTests.has(name)).map(name => `tests/${name}`)]);
process.exitCode = nodeStatus || bunStatus;
