import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as configModule from "../src/config";
import * as integration from "../src/codex-integration";
import * as service from "../src/service";
import * as tunnel from "../src/tunnel";
import * as tunnelService from "../src/tunnel-service";
import * as browserHost from "../src/launcher-browser-host";
import * as browserLogin from "../src/browser-login";
import { inspectLauncherCapabilities, launcherCapabilityProbeRequired, preflightSetup, setup, setupDevProfile, setupProxyIsReady } from "../src/setup";
import { VERSION } from "../src/version";

const { RuntimeHost } = require("../launcher/electron/runtime.cjs");
const { RuntimeSupervisor } = require("../launcher/electron/runtime-supervisor.cjs");

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("launcher setup refreshes account capabilities only when missing or explicitly requested", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  };

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({ ...verifiedLauncher, extraHighAvailable: undefined } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    extraHighAvailable: false, proAvailable: false,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never, true)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never, false, "automatic")).toBe(true);
});

for (const interaction of ["automatic", "manual"] as const) {
  test(`full launcher upgrade preserves an existing custom connector identity in ${interaction} mode`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-upgrade-identity-"));
    const configPath = join(root, "config.json");
    const key = join(root, "runtime.key");
    writeFileSync(configPath, "{}\n");
    writeFileSync(key, "fixture-runtime-key");
    const old: configModule.AppConfig = {
      ...configModule.defaultConfig("full"),
      releaseVersion: "5.0.96",
      browserHost: "launcher" as const,
      browserInteractionMode: interaction,
      appName: interaction === "manual" ? configModule.ZERO_RISK_CHATGPT_CONNECTOR_NAME : "PC2 Explicit Main Alias",
      automaticAppName: "Codex Native2 PC2",
      manualAppName: "Codex Zero Risk",
      acknowledgedUnofficialAt: new Date().toISOString(),
    };
    let saved: configModule.AppConfig | undefined;
    const mocks = [
      spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
      spyOn(configModule, "loadConfigForSetup").mockReturnValue(old),
      spyOn(configModule, "saveConfig").mockImplementation(value => { saved = value; }),
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never)),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
      spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
      spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
      spyOn(tunnel, "connectTunnel").mockImplementation(() => { throw new Error("unexpected external tunnel"); }),
      spyOn(tunnel, "stopTunnel").mockImplementation(() => { throw new Error("unexpected tunnel shutdown"); }),
      spyOn(browserHost, "inspectLauncherBrowserHost").mockResolvedValue({ solAvailable: true, proAvailable: false, extraHighAvailable: false } as never),
    ];
    try {
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      await setup({ mode: "full", browserInteractionMode: interaction,
        browserHostDescriptorPath: join(root, "launcher.json"),
        tunnelId: `tunnel_${"c".repeat(32)}`, port,
        acknowledgedUnofficial: true });
      expect(saved?.automaticAppName).toBe("Codex Native2 PC2");
      expect(saved?.appName).toBe(old.appName);
      expect(saved?.manualAppName).toBe(old.manualAppName);
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("isolated 5.0.96 to 5.1.x full upgrade keeps the PC2 connector, versioned Bun and first-launch readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-upgrade-e2e-"));
  const bundleDir = resolve(import.meta.dir, "../launcher/build");
  mkdirSync(bundleDir, { recursive: true });
  const versionedRoot = mkdtempSync(join(bundleDir, "test-versioned-bun-"));
  const versionedBun = join(versionedRoot, "bun.exe");
  const descriptor = join(root, "launcher-browser.json");
  const configPath = join(root, "config.json");
  const key = join(root, "runtime.key");
  const binaryPath = join(root, "tunnel-client.exe");
  const healthFile = join(root, "tunnel-health.url");
  writeFileSync(versionedBun, "mock versioned executable");
  writeFileSync(key, "fixture-runtime-key");
  writeFileSync(binaryPath, "mock tunnel client");
  writeFileSync(healthFile, "http://127.0.0.1:43127\n");
  const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;
  const originalCodex = process.env.CODEX_HOME;
  const originalBun = process.env.CODEX_CHATGPT_WEB_BUN;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CODEX_CHATGPT_WEB_BUN = versionedBun;
  const id = `tunnel_${"c".repeat(32)}`;
  const previousTunnel = {
    binaryPath, tunnelId: id, runtimeKeyFile: key,
    profileDir: join(root, "tunnel", "profiles"),
    profileName: "codex-chatgpt-web", alias: "codex-chatgpt-web",
  };
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = listener.port!;
  await listener.stop(true);
  const old = {
    ...configModule.defaultConfig("full"),
    port,
    releaseVersion: "5.0.96", browserHost: "launcher" as const,
    browserHostDescriptorPath: descriptor, browserInteractionMode: "automatic" as const,
    appName: "Codex Native2 PC2", automaticAppName: "Codex Native2 PC2",
    manualAppName: configModule.ZERO_RISK_CHATGPT_CONNECTOR_NAME,
    tunnel: previousTunnel, automaticTunnel: previousTunnel,
    acknowledgedUnofficialAt: new Date().toISOString(),
  };
  writeFileSync(configPath, `${JSON.stringify(old)}\n`, "utf8");
  const mocks = [
    spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
    spyOn(configModule, "loadConfigForSetup").mockImplementation(() => JSON.parse(readFileSync(configPath, "utf8"))),
    spyOn(configModule, "saveConfig").mockImplementation(value => writeFileSync(configPath, `${JSON.stringify(value)}\n`, "utf8")),
    spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
    spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never)),
    spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
    spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
    spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
    spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
    spyOn(tunnel, "installTunnelClient").mockResolvedValue(binaryPath),
    spyOn(browserHost, "inspectLauncherBrowserHost").mockResolvedValue({ solAvailable: true, extraHighAvailable: false, proAvailable: false } as never),
  ];
  const app = { getVersion: () => VERSION, isPackaged: false, getPath: () => root };
  const logger = { info() {}, warn() {}, error() {} };
  const supervisor = new RuntimeSupervisor({ app, logger, sourceRoot: root,
    coreHome: root, browserDescriptorPath: descriptor });
  let inventory = 0;
  let discovery = 0;
  supervisor.stopForSetup = async () => ({ status: "stopped" });
  supervisor.readState = () => null;
  supervisor.writeState = () => {};
  supervisor.proxyHealth = async () => false;
  supervisor.startDaemon = async () => { supervisor.daemon = { pid: process.pid }; };
  supervisor.startTunnelMonitor = () => {};
  supervisor.probeTunnelMcpTransport = async () => ({ observed: true, ok: true, fatal: false });
  supervisor.runTunnelCommand = async (_config: unknown, args: string[]) => {
    if (args.includes("cleanup")) {
      inventory++;
      return { code: 0, output: inventory <= 2 ? "" : JSON.stringify({ entries: [
        { alias: "codex-chatgpt-web", runtime_state: "ready", live_runtime: { system: { pid: process.pid } } },
      ] }) };
    }
    discovery++;
    return { code: 0, output: discovery <= 2 ? "" : JSON.stringify({ aliases: [
      { alias: "codex-chatgpt-web", health_url_file: healthFile },
    ] }) };
  };
  const host = new RuntimeHost({ app, logger, sourceRoot: root, coreHome: root,
    codexHome: join(root, "codex"), browserDescriptorPath: descriptor, supervisor });
  host.run = async (_name: string, args: string[]) => {
    const options = { mode: "full" as const, browserInteractionMode: "automatic" as const,
      browserHostDescriptorPath: descriptor, refreshAccountCapabilities: true,
      acknowledgedUnofficial: true, restartService: true };
    if (args.includes("--preflight-only")) preflightSetup(options);
    else await setup(options);
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const result = await host.upgradeManagedRuntime();
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(result.updated).toBe(true);
    expect(result.fromVersion).toBe("5.0.96");
    expect(result.toVersion).toBe(VERSION);
    expect(after.appName).toBe("Codex Native2 PC2");
    expect(after.automaticAppName).toBe("Codex Native2 PC2");
    expect(after.manualAppName).toBe(configModule.ZERO_RISK_CHATGPT_CONNECTOR_NAME);
    expect(after.runtimeCommand[0]).toBe(versionedBun);
    expect(inventory).toBe(3);
    expect(discovery).toBe(3);
    expect(supervisor.readConfig()?.releaseVersion).toBe(VERSION);
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
    if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
    if (originalCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodex;
    if (originalBun === undefined) delete process.env.CODEX_CHATGPT_WEB_BUN;
    else process.env.CODEX_CHATGPT_WEB_BUN = originalBun;
    rmSync(versionedRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed capability refresh keeps the measured model list instead of failing setup", async () => {
  const stored = {
    browserHost: "launcher",
    browserInteractionMode: "automatic",
    browserHostDescriptorPath: "launcher-browser.json",
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  } as never;
  const calls: boolean[] = [];
  const inspect = spyOn(browserHost, "inspectLauncherBrowserHost").mockImplementation(async (_path, options) => {
    calls.push(options?.detectCapabilities === true);
    if (options?.detectCapabilities) throw new Error("locator.waitFor: Timeout 70000ms exceeded.");
    return { url: "https://chatgpt.com/?temporary-chat=true" };
  });
  try {
    const kept = await inspectLauncherCapabilities(stored, stored, true, "production");
    expect(calls).toEqual([true, false]);
    expect(kept).toMatchObject({ solAvailable: true, extraHighAvailable: false, proAvailable: false });
    expect(kept.refreshWarning).toContain("Timeout 70000ms");

    // Nothing measured yet: a failed first probe must fail, never default to a model list.
    calls.length = 0;
    const unmeasured = { ...(stored as object), solAvailable: undefined } as never;
    await expect(inspectLauncherCapabilities(unmeasured, unmeasured, false, "production"))
      .rejects.toThrow("Timeout 70000ms");
    expect(calls).toEqual([true]);

    calls.length = 0;
    inspect.mockImplementation(async (_path, options) => {
      calls.push(options?.detectCapabilities === true);
      return { url: "https://chatgpt.com/?temporary-chat=true", solAvailable: true, extraHighAvailable: true, proAvailable: false };
    });
    const refreshed = await inspectLauncherCapabilities(stored, stored, true, "production");
    expect(calls).toEqual([true]);
    expect(refreshed).toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: false });
  } finally {
    inspect.mockRestore();
  }
});

for (const development of [false, true]) for (const interaction of ["manual", "automatic"] as const) {
  test(`${development ? "DEV" : "production"} ${interaction} setup commits the tunnel inputs before its supervisor starts the runtime`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-setup-owner-"));
    const key = join(root, "runtime.key");
    writeFileSync(key, "fixture-runtime-key");
    const calls: string[] = [];
    let saved: configModule.AppConfig | undefined;
    const mocks = [
      spyOn(configModule, "getConfigPath").mockReturnValue(join(root, "config.json")),
      spyOn(configModule, "saveConfig").mockImplementation(value => { saved = value; calls.push("save"); }),
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(integration, "installCodexIntegration").mockImplementation(() => { calls.push("integrate"); return {} as never; }),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
      spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
      spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
      spyOn(tunnel, "connectTunnel").mockImplementation(() => { throw new Error("setup started a runtime before committing its inputs"); }),
      spyOn(tunnel, "stopTunnel").mockImplementation(() => { throw new Error("setup stopped the supervisor's runtime"); }),
      spyOn(browserHost, "inspectLauncherBrowserHost").mockResolvedValue({ solAvailable: true, proAvailable: true, extraHighAvailable: true } as never),
    ];
    try {
      const options = {
        mode: "full" as const,
        browserInteractionMode: interaction,
        subagentProtocol: "native" as const,
        browserHostDescriptorPath: join(root, "launcher-browser.json"),
        tunnelId: `tunnel_${"a".repeat(32)}`,
        acknowledgedUnofficial: true,
      };
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      const result = await (development ? setupDevProfile : setup)({ ...options, port });
      expect(calls).toEqual(development ? ["save"] : ["save", "integrate"]);
      expect(saved?.tunnel?.alias).toBe(`codex-chatgpt-web${development ? "-dev" : ""}${interaction === "manual" ? "-zero-risk" : ""}`);
      expect(result.tunnelReady).not.toBe(true);
      expect(result.connectorSetupRequired).toBe(true);

      calls.length = 0;
      mocks.push(spyOn(configModule, "saveConfig").mockImplementation(() => { throw new Error("config commit failed"); }));
      await expect((development ? setupDevProfile : setup)({ ...options, port })).rejects.toThrow("config commit failed");
      expect(calls).toEqual([]);
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test.skipIf(process.platform !== "darwin")("external service setup retains validation cleanup on success and failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-external-setup-"));
  const configPath = join(root, "config.json");
  const key = join(root, "runtime.key");
  writeFileSync(key, "fixture-runtime-key");
  writeFileSync(configPath, "{}");
  const existing = {
    ...configModule.defaultConfig("full"),
    subagentProtocol: "native" as const,
    acknowledgedUnofficialAt: new Date().toISOString(),
  };
  const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({
    service: "codex-chatgpt-web", status: "ok", mode: "full", version: existing.releaseVersion, accepting_turns: true,
  }) });
  existing.port = proxy.port!;
  const calls: string[] = [];
  let ready = true;
  let stopFails = false;
  const mocks = [
    spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
    spyOn(configModule, "loadConfigForSetup").mockReturnValue(existing),
    spyOn(configModule, "saveConfig").mockImplementation(() => {}),
    spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
    spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never)),
    spyOn(browserLogin, "browserLoginStateExists").mockReturnValue(true),
    spyOn(browserLogin, "storedBrowserLoginCapabilities").mockReturnValue({ solAvailable: true, extraHighAvailable: false, proAvailable: false } as never),
    spyOn(service, "getServiceStatus").mockReturnValue({ installed: true, loaded: true } as never),
    spyOn(service, "assertServiceIdle").mockResolvedValue(undefined),
    spyOn(service, "installService").mockReturnValue({ installed: true, loaded: true } as never),
    spyOn(service, "restartService").mockResolvedValue({ installed: true, loaded: true } as never),
    spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
    spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
    spyOn(tunnelService, "installTunnelService").mockImplementation(() => { calls.push("service"); return { installed: true, loaded: true } as never; }),
    spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
    spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
    spyOn(tunnel, "connectTunnel").mockImplementation(() => { calls.push("connect"); }),
    spyOn(tunnel, "waitForTunnelReady").mockImplementation(async () => { calls.push("ready"); return { ok: ready, detail: "fixture readiness" } as never; }),
    spyOn(tunnel, "stopTunnel").mockImplementation(() => {
      calls.push("stop");
      if (stopFails) throw new Error("fixture stop failure");
    }),
  ];
  try {
    const options = { mode: "full" as const, subagentProtocol: "native" as const, tunnelId: `tunnel_${"b".repeat(32)}`, restartService: true };
    expect((await setup(options)).tunnelReady).toBe(true);
    expect(calls).toEqual(["connect", "ready", "stop", "service", "ready"]);
    ready = false;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("did not become healthy and ready");
    expect(calls).toEqual(["connect", "ready", "stop"]);
    stopFails = true;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("fixture readiness; temporary tunnel cleanup also failed: fixture stop failure");
    expect(calls).toEqual(["connect", "ready", "stop"]);
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
    await proxy.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
