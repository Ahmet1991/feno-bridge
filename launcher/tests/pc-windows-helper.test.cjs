const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const activationFixture = require('./helpers/pc-window-activation-fixture.cjs');

test('disabled target returns focus_required without sending any input', {skip:process.platform!=='win32'}, () => {
  const result=activationFixture({disabled:true});
  assert.equal(result.status,1,result.stderr||result.stdout);
  assert.deepEqual(JSON.parse(result.stdout),{ok:false,reason:'focus_required'});
  assert.equal(result.audit.writes,0);assert.equal(result.audit.attached,0);
});

test('approved target can request UI Automation focus after native activation fails, with queues detached', {skip:process.platform!=='win32'}, () => {
  const result=activationFixture({denied:true,uia:true});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.equal(result.audit.writes,1);assert.equal(result.audit.attached,0);assert.equal(result.audit.foreground,101);
});

test('owned foreground editor remains a valid target after UI Automation focuses its child HWND', {skip:process.platform!=='win32'}, () => {
  const result=activationFixture({denied:true,uia:true,foregroundChild:true});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.equal(result.audit.writes,1);assert.equal(result.audit.attached,0);assert.equal(result.audit.foreground,303);
});

test('a child foreground handle in another process never receives input', {skip:process.platform!=='win32'}, () => {
  const result=activationFixture({denied:true,uia:true,foregroundChild:'other-process'});
  assert.equal(result.status,1,result.stderr);
  assert.equal(result.audit.writes,0);assert.equal(result.audit.attached,0);
});

test('background activation transfers foreground ownership and detaches before sending a key', {skip:process.platform!=='win32'}, () => {
  const result=activationFixture();
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.deepEqual(JSON.parse(result.stdout),{ok:true});
  assert.deepEqual(result.audit,{writes:1,attached:0,foreground:101,x:0,y:0});
});

test('unsuccessful activation never sends input and releases every attached queue', {skip:process.platform!=='win32'}, () => {
  const result=activationFixture({denied:true});
  assert.equal(result.status,1,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{ok:false,reason:'focus_required'});
  assert.equal(result.audit.writes,0);assert.equal(result.audit.attached,0);
});

test('a minimized target is restored and its bounds refreshed before a click', {skip:process.platform!=='win32'}, () => {
  const result=activationFixture({minimized:true,action:'click'});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.deepEqual(result.audit,{writes:1,attached:0,foreground:101,x:300,y:280});
});

test('a foreground change during typing prevents the next character reaching another window', {skip:process.platform!=='win32'}, () => {
  const result=activationFixture({action:'type',steal:true});
  assert.equal(result.status,1,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{ok:false,reason:'focus_required'});
  assert.equal(result.audit.writes,1);assert.equal(result.audit.foreground,202);assert.equal(result.audit.attached,0);
});

test("foreground refusal returns a bounded focus reason without exception or argument disclosure", {
  skip: process.platform !== "win32", timeout: 30000,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feno-window-focus-"));
  const scriptPath = path.join(directory, "helper.ps1");
  const original = fs.readFileSync(path.join(__dirname, "../electron/pc-windows-helper.ps1"), "utf8");
  // Replace the OS/session dependency, retaining the real helper's failure serializer.
  const script = original.replace("if ($payload.action -eq 'session') {", "if ($payload.action -eq 'session') { throw 'cannot activate window'\n");
  assert.notEqual(script, original);
  fs.writeFileSync(scriptPath, "\uFEFF" + script);
  try {
    const result = spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
        "-PayloadBase64", Buffer.from(JSON.stringify({ action: "session", args: {} })).toString("base64")],
      { windowsHide: true, encoding: "utf8", timeout: 12000 });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, reason: "focus_required" });
  } finally { fs.unlinkSync(scriptPath); fs.rmdirSync(directory); }
});

test("helper transports Unicode window identity as UTF-8 JSON through a redirected pipe", {
  skip: process.platform !== "win32", timeout: 30000,
}, () => {
  const expected = { id: "101", title: "İndirilenler ğüşıöç 測試 🦅", processName: "explorer.exe" };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feno-window-encoding-"));
  const scriptPath = path.join(directory, "helper.ps1");
  const original = fs.readFileSync(path.join(__dirname, "../electron/pc-windows-helper.ps1"), "utf8");
  // Isolate OS enumeration, while exercising the actual helper's JSON/stdout transport.
  const fixture = `\nfunction Test-UnlockedDesktop { return $true }\nfunction Get-Windows { return @(('${JSON.stringify(expected)}' | ConvertFrom-Json)) }\n`;
  const script = original.replace(/\r?\ntry \{\r?\n    if \(\$PayloadBase64/, `${fixture}\ntry {\n    if ($PayloadBase64`);
  assert.notEqual(script, original, "fixture must be inserted at the native enumeration boundary");
  fs.writeFileSync(scriptPath, "\uFEFF" + script);
  try {
    const result = spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
        "-PayloadBase64", Buffer.from(JSON.stringify({ action: "list", args: {} })).toString("base64")],
      { windowsHide: true, encoding: "utf8", timeout: 12000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), [expected]);
  } finally {
    fs.unlinkSync(scriptPath);
    fs.rmdirSync(directory);
  }
});

test("packaged Windows helper lists the unlocked desktop without assigning PowerShell automatic variables", {
  skip: process.platform !== "win32", timeout: 30000,
}, t => {
  const helper = action => spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(__dirname, "../electron/pc-windows-helper.ps1"), "-PayloadBase64",
      Buffer.from(JSON.stringify({ action, args: {} })).toString("base64")],
    { windowsHide: true, encoding: "utf8", timeout: 12000 });
  const session = helper("session");
  assert.equal(session.status, 0, session.stderr || session.error?.message);
  if (!JSON.parse(session.stdout).unlocked) { t.skip("An unlocked interactive desktop is required"); return; }
  const listed = helper("list");
  assert.equal(listed.status, 0, "window enumeration must succeed in Windows PowerShell 5.1");
  const windows = JSON.parse(listed.stdout);
  assert.ok(Array.isArray(windows));
  assert.ok(windows.length <= 300);
  for (const window of windows) {
    assert.match(window.id, /^[1-9][0-9]{0,15}$/);
    assert.equal(typeof window.title, "string");
    assert.match(window.processName, /\.exe$/i);
  }
});
