"use strict";
// Reproducible source build; writes only to this checkout's ignored .cache directory.
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
if (process.platform !== "win32") throw new Error("Windows is required");
const system = process.env.SystemRoot || "C:\\Windows";
const compiler = ["Framework64", "Framework"]
  .map(folder => path.join(system, "Microsoft.NET", folder, "v4.0.30319", "csc.exe"))
  .find(fs.existsSync);
if (!compiler) throw new Error(".NET Framework C# compiler not found");
function gac(name) {
  const root = path.join(system, "Microsoft.NET", "assembly", "GAC_MSIL", name);
  const matches = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, `${name}.dll`))
    .filter(fs.existsSync);
  if (matches.length !== 1) throw new Error(`Expected one trusted ${name} assembly`);
  return matches[0];
}
const output = path.join(__dirname, "..", ".cache", "pc-windows-helper.exe");
fs.mkdirSync(path.dirname(output), { recursive: true });
const args = ["/nologo", "/target:exe", `/out:${output}`,
  "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Web.Extensions.dll",
  ...["UIAutomationClient", "UIAutomationTypes", "WindowsBase"].map(name => `/reference:${gac(name)}`),
  path.join(__dirname, "..", "launcher", "electron", "pc-windows-helper.cs")];
const result = cp.spawnSync(compiler, args, { stdio: "inherit", windowsHide: true, shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const hash = crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex");
const manifest = path.join(__dirname, "..", "launcher", "electron", "pc-windows-helper.sha256");
fs.writeFileSync(manifest, `${hash}\n`, { encoding: "utf8" });
process.stdout.write(`Compiled ${output} SHA256=${hash}\n`);
