import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseSetupArgs } from "../src/cli";
import { parseDevSetupArgs } from "../src/dev-chat/cli";

const require = createRequire(import.meta.url);
const { RuntimeHost } = require("../launcher/electron/runtime.cjs") as {
  RuntimeHost: new (options: Record<string, unknown>) => any;
};

type SetupInvocation = { name: string; args: string[] };

function assertCliAccepts(args: string[]): void {
  if (args[0] === "setup") {
    const setupArgs = args.slice(1);
    parseSetupArgs(setupArgs);
    parseSetupArgs([...setupArgs, "--preflight-only"]);
    return;
  }
  if (args[0] === "dev" && args[1] === "setup") {
    parseDevSetupArgs(args.slice(2), "/unused/launcher-browser.json");
    return;
  }
  throw new Error(`Unexpected launcher setup command: ${args.join(" ")}`);
}

function hostFor(
  config: Record<string, unknown> | null,
  profile: "production" | "development" = "production",
  interactionMode: "automatic" | "manual" = "automatic",
): { host: any; invocations: SetupInvocation[] } {
  const invocations: SetupInvocation[] = [];
  const host = new RuntimeHost({
    app: {
      getPath: () => join(tmpdir(), `feno-launcher-cli-seam-${profile}`),
      getVersion: () => "5.0.18",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: profile === "development"
      ? "/dev/runtime/launcher-browser.json"
      : "/runtime/launcher-browser.json",
    ...(profile === "development" ? { coreHome: "/dev", launcherProfile: "development" } : {}),
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => ({ status: "stopped" }),
      startIfConfigured: async () => ({ status: "ready" }),
    },
    getBrowserInteractionMode: () => interactionMode,
  });
  const capture = async (name: string, args: string[], options: { afterRuntimeReady?: () => Promise<void> } = {}) => {
    assertCliAccepts(args);
    invocations.push({ name, args });
    await options.afterRuntimeReady?.();
    return { code: 0, stdout: "", stderr: "" };
  };
  host.runSetup = capture;
  host.runDevSetup = capture;
  return { host, invocations };
}

test("every launcher-generated setup command is accepted by the matching CLI parser", async () => {
  const keyRoot = mkdtempSync(join(tmpdir(), "feno-launcher-cli-seam-key-"));
  const runtimeKeyFile = join(keyRoot, "runtime.key");
  writeFileSync(runtimeKeyFile, "saved-private-runtime-key\n", { mode: 0o600 });
  const operationNames: string[] = [];
  const exercise = async (
    fixture: { host: any; invocations: SetupInvocation[] },
    operation: (host: any) => Promise<unknown>,
  ) => {
    await operation(fixture.host);
    expect(fixture.invocations.length).toBeGreaterThan(0);
    operationNames.push(...fixture.invocations.map(invocation => invocation.name));
  };
  const automaticFull = {
    mode: "full",
    browserHost: "launcher",
    browserInteractionMode: "automatic",
    appName: "Codex Native2",
  };
  const manualFull = {
    mode: "full",
    browserHost: "launcher",
    browserInteractionMode: "manual",
    appName: "Codex Zero Risk",
    automaticAppName: "Codex Native2",
  };
  try {
    await exercise(hostFor(automaticFull), host => host.setupCore());
    await exercise(hostFor(null, "development"), host => host.setupDevCore());
    await exercise(hostFor({ ...automaticFull, autoApproveToolCalls: true }), host => host.setBiggerContext(true));
    await exercise(
      hostFor({ ...automaticFull, autoApproveToolCalls: true }, "development"),
      host => host.setBiggerContext(false),
    );

    for (const enabled of [true, false]) {
      await exercise(hostFor(automaticFull), host => host.setSkillAttachments(enabled));
      await exercise(
        hostFor({ ...automaticFull, autoApproveToolCalls: true }, "development"),
        host => host.setSkillAttachments(enabled),
      );
      await exercise(hostFor(manualFull, "production", "manual"), host => host.setZeroRiskPro(enabled));
      await exercise(hostFor(manualFull, "development", "manual"), host => host.setZeroRiskPro(enabled));
    }

    await exercise(
      hostFor({ ...automaticFull, releaseVersion: "5.0.17" }),
      host => host.upgradeManagedRuntime(),
    );
    await exercise(
      hostFor({ ...manualFull, releaseVersion: "5.0.17" }, "production", "manual"),
      host => host.upgradeManagedRuntime(),
    );

    const savedTunnel = {
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile,
    };
    await exercise(
      hostFor({ ...automaticFull, tunnel: savedTunnel }),
      host => host.setupMcp({ replace: false }),
    );
    await exercise(
      hostFor({ ...automaticFull, tunnel: savedTunnel }, "development"),
      host => host.setupDevMcp({ replace: false }),
    );
    await exercise(hostFor(automaticFull), host => host.setBrowserInteractionMode("manual"));
    await exercise(
      hostFor({ ...manualFull, experimentalBiggerContext: true, autoApproveToolCalls: true }, "production", "manual"),
      host => host.setBrowserInteractionMode("automatic"),
    );
    await exercise(
      hostFor({ ...manualFull, autoApproveToolCalls: true }, "development", "manual"),
      host => host.setBrowserInteractionMode("automatic"),
    );

    expect(operationNames).toEqual([
      "core-setup",
      "dev-profile-setup",
      "bigger-context",
      "bigger-context",
      "skill-attachments",
      "skill-attachments",
      "zero-risk-pro",
      "zero-risk-pro",
      "skill-attachments",
      "skill-attachments",
      "zero-risk-pro",
      "zero-risk-pro",
      "runtime-upgrade",
      "runtime-upgrade",
      "mcp-setup",
      "dev-mcp-setup",
      "browser-interaction-mode",
      "browser-interaction-mode",
      "browser-interaction-mode",
    ]);
  } finally {
    rmSync(keyRoot, { recursive: true, force: true });
  }
});
