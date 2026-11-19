import { readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Read-only: report leaks without touching any other process's files.
const root = tmpdir();
const prefixes = [
  'pc-files-task4-', 'pc-core-mcp-', 'pc2-mcp-contract-', 'pc-service-test-',
  'pc-core-flow-', 'pc-full-access-', 'pc-dev-peer-unit-', 'feno-pc-browser-smoke-',
  'feno-own-chrome-', 'pc-no-dev-', 'pc-peer-test-', 'pc-akentek-dev-install-',
  'pc-no-localappdata-', 'pc-existing-runtime-', 'pc-retirement-service-',
  'pc-store-security-', 'chrome-broker-test-', 'feno-native-host-test-',
  'feno-acl-', 'build-stamp-', 'pc-acceptance-notepad-', 'pc-acceptance-515-',
  'pc2-t23-', 'pc2-t31-', 'pc-browser-test-', 'pc-proxy-test-', 'pc-adb-e2e-',
  'feno-pc2-desktop-e2e-', 'pc-resource-race-', 'pc-resource-crash-',
  'pc-jobs-', 'pc-log-', 'pc-resource-unit-', 'pc-grant-rotate-',
  'pc-notepad-file-', 'pc-lineage-', 'pc-path-security-', 'pc-image-',
  'pc-signed-security-', 'pc-replay-security-', 'pc-heartbeat-security-',
  'pc-async-revoke-', 'codex-web-environment-', 'codex-chatgpt-web-live-subagents-',
  'codex-web-gpt-runtime-host-test-', 'codex-web-gpt-dev-runtime-host-test-',
  'feno-test-homes-', 'feno-environment-workspace-',
  'pc-private-cleanup-',
];
let leaks = 0;
function check(directory: string, names: string[]) {
  const entries = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : [];
  for (const prefix of names) {
    const count = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(prefix)).length;
    console.log(prefix + ': ' + count);
    leaks += count;
  }
}
check(root, prefixes);
if (leaks && !process.argv.includes('--report-only')) process.exitCode = 1;
