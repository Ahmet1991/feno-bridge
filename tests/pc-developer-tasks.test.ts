import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferPcDeveloperTasks } from "../src/pc-control/developer-tasks";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { createLocalPcHost } from "../src/pc-control/mcp-tools";

test("developer task catalog discovers safe project scripts, Gradle tests/build and read-only Git", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-dev-catalog-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    test: "vitest run", "test:unit": "vitest run src", typecheck: "tsc --noEmit",
    lint: "eslint .", build: "vite build", verify: "echo verify",
    "build:release": "publish-site", "test:deploy": "deploy", deploy: "push-to-production",
    clean: "rm -rf dist", "custom-script": "echo no",
  } }));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "android"));
  writeFileSync(join(root, "android", "gradlew.bat"), "@echo off\r\n");

  const tasks = inferPcDeveloperTasks(root, "win32");
  expect(Object.keys(tasks).sort()).toEqual([
    "android:assembleDebug", "android:lintDebug", "android:testDebugUnitTest",
    "git:diff-stat", "git:log", "git:status",
    "script:build", "script:lint", "script:test", "script:test:unit", "script:typecheck", "script:verify",
  ].sort());
  expect(tasks["script:test"]?.args).toEqual(["run", "test"]);
  expect(tasks["git:status"]?.args).toEqual(["-c", "core.pager=cat", "status", "--short", "--branch"]);
  expect(tasks["android:testDebugUnitTest"]?.args).toEqual([
    "/d", "/s", "/c", "android\\gradlew.bat testDebugUnitTest",
  ]);
});

test("developer task catalog never promotes unknown manifest names, wrapper paths or broad shell commands", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-dev-safe-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    "build:publish": "evil", "verify:prod": "evil", "test:clean": "evil",
    "lint:../../bad": "evil", "build:foo --bad": "evil",
    "build:good": "echo yes", setup: "echo no",
  } }));
  const tasks = inferPcDeveloperTasks(root, "win32");
  expect(Object.keys(tasks)).toEqual(["script:build:good"]);
  expect(tasks["script:build:good"]?.command).toBe(process.execPath);
});

test("developer tasks require a valid manifest and cannot list more than a bounded set", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-dev-bounded-"));
  expect(inferPcDeveloperTasks(root, "win32")).toEqual({});
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [`test:${i}`, "echo hello"]),
  ) }));
  expect(Object.keys(inferPcDeveloperTasks(root, "win32"))).toHaveLength(64);
});

test("one parent-folder grant lists and runs developer tasks in separate child projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "pc-dev-multi-"));
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  mkdirSync(alpha);
  mkdirSync(beta);
  writeFileSync(join(alpha, "package.json"), JSON.stringify({ scripts: { test: "echo alpha" } }));
  writeFileSync(join(beta, "package.json"), JSON.stringify({ scripts: { lint: "echo beta" } }));
  const policy = new PcAuthorizer();
  policy.setGrantFromLocalApproval({ id: "multi-project-local-grant", expiresAt: Date.now() + 60_000,
    roots: [root], permissions: ["jobs"], allowedApps: [] });
  const host = createLocalPcHost(policy);
  expect(await host.listProjectTasks!(alpha)).toEqual(["script:test"]);
  expect(await host.listProjectTasks!(beta)).toEqual(["script:lint"]);
  await expect(host.listProjectTasks!(join(root, ".."))).rejects.toThrow("pc_access_denied");
  await expect(host.startProjectTask!(alpha, "script:deploy")).rejects.toThrow("pc_access_denied");
  const a = await host.startProjectTask!(alpha, "script:test") as { jobId: string };
  const b = await host.startProjectTask!(beta, "script:lint") as { jobId: string };
  expect(a.jobId).not.toBe(b.jobId);
  expect(await host.jobStatus!(a.jobId)).toMatchObject({ state: expect.any(String) });
  expect(await host.jobStatus!(b.jobId)).toMatchObject({ state: expect.any(String) });
  await host.revokeActiveJobs?.();
  policy.revoke();
  await expect(host.jobStatus!(a.jobId)).rejects.toThrow("pc_access_denied");
});
