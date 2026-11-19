import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalTemp } from "./support/canonical-temp";

test("libvips licenses are included for every release platform, without bypassing unknown versions", () => {
  const fixture = canonicalTemp("third-party-notices-");
  const root = resolve(import.meta.dir, "..");
  const names = [
    ...["linux-x64", "darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64", "linux-ppc64", "linux-riscv64", "linux-s390x", "linuxmusl-arm64", "linuxmusl-x64"].map(platform => `@img/sharp-libvips-${platform}`),
    ...["x64", "arm64", "ia32"].map(arch => `@img/sharp-win32-${arch}`),
  ];
  try {
    mkdirSync(join(fixture, "scripts"));
    const script = join(fixture, "scripts", "generate-third-party-notices.ts");
    cpSync(join(root, "scripts", "generate-third-party-notices.ts"), script);
    cpSync(join(root, "LICENSES"), join(fixture, "LICENSES"), { recursive: true });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ dependencies: Object.fromEntries(names.map(name => [name, "*"])) }));
    for (const name of names) {
      const dir = join(fixture, "node_modules", name);
      const windows = name.includes("win32");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: windows ? "0.35.5" : "1.3.4", license: windows ? "Apache-2.0 AND LGPL-3.0-or-later" : "LGPL-3.0-or-later" }));
      if (windows) writeFileSync(join(dir, "LICENSE"), "Native package license sentinel");
    }
    const destination = join(fixture, "notices.txt");
    const run = () => Bun.spawnSync([process.execPath, script, destination], { cwd: fixture });
    const result = run();
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const output = readFileSync(destination, "utf8");
    for (const name of names) {
      const windows = name.includes("win32");
      const section = output.split(`${name}@${windows ? "0.35.5" : "1.3.4"} (`)[1]?.split("\n" + "=".repeat(80))[0];
      expect(section).toBeDefined();
      for (const file of ["libvips-LGPL-3.0.txt", "libvips-GPL-3.0.txt"]) {
        expect(section).toContain(readFileSync(join(root, "LICENSES", file), "utf8").trim());
      }
      if (windows) expect(section).toContain("Native package license sentinel");
    }
    const name = names[0]!;
    writeFileSync(join(fixture, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.3.5", license: "LGPL-3.0-or-later" }));
    const unknown = run();
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr.toString()).toContain(`No license/notice file found for ${name}@1.3.5`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
