const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");

test("the Update button checks the ChatGPT session before it offers to install (29.09)", () => {
  // 29.09: an update installed while signed out could not inspect the session and needed a repair.
  const start = main.indexOf('handle("launcher:update-install"');
  assert.ok(start > 0);
  const handler = main.slice(start, main.indexOf('handle("launcher:update-check"', start));
  const refresh = handler.indexOf("browserHost.refreshAuthentication()");
  const refusal = handler.indexOf("throw new Error(copy.updateSignInRequired)");
  const dialog = handler.indexOf("dialog.showMessageBox");
  const install = handler.indexOf("updateController.beginInstall()");
  assert.ok(refresh > 0, "the handler re-checks the session");
  assert.ok(refresh < refusal && refusal < dialog && dialog < install, "check, refuse, then confirm and install");
});

test("every language explains why an update waits for sign-in", () => {
  const copies = main.match(/updateSignInRequired: "[^"]+"/g) ?? [];
  assert.equal(copies.length, 6);
  assert.ok(copies.some(line => line.includes("Güncellemeden önce ChatGPT'ye giriş yapın")));
});

test("the launcher shows the handler's own message, not Electron's IPC prefix", () => {
  const source = app.match(/function messageOf\(value: unknown\): string \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, "messageOf is missing");
  const messageOf = new Function(`${source.replace(": unknown", "").replace("): string", ")")}; return messageOf;`)();
  const refusal = "Güncellemeden önce ChatGPT'ye giriş yapın.";
  assert.equal(messageOf(new Error(`Error invoking remote method 'launcher:update-install': Error: ${refusal}`)), refusal);
  assert.equal(messageOf(new Error(`Error invoking remote method 'launcher:update-install': ${refusal}`)), refusal);
  assert.equal(messageOf(new Error(refusal)), refusal);
  assert.equal(messageOf("plain"), "plain");
});
