import { expect, test } from "bun:test";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { createPcWindowsController } from "../src/pc-control/windows";

function auth() {
  const policy = new PcAuthorizer();
  policy.setGrantFromLocalApproval({ id: `windows-session-${crypto.randomUUID()}`, expiresAt: Date.now() + 60_000,
    roots: [], permissions: ["screen.read", "desktop.input"], allowedApps: ["notepad.exe"] });
  return policy;
}

test("desktop requires an unlocked interactive session and an approved target app", async () => {
  let unlocked = false;
  const received: unknown[] = [];
  const controller = createPcWindowsController({ authorizer: auth(), isInteractive: async () => unlocked,
    runHelper: async (action, args) => {
      received.push({ action, args });
      if (action === "list") return [{ id: "101", title: "Document", processName: "notepad.exe" }, { id: "102", title: "Secret", processName: "password-manager.exe" }];
      if (action === "capture") return { mimeType: "image/png", base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64") };
      return { ok: true };
    },
  });
  await expect(controller.listPcWindows()).rejects.toThrow("pc_access_denied");
  unlocked = true;
  expect(await controller.listPcWindows()).toEqual([{ id: "101", title: "Document", processName: "notepad.exe" }]);
  await expect(controller.capturePcWindow("102")).rejects.toThrow("pc_access_denied");
  const screen = await controller.capturePcWindow("101");
  expect(screen.data.length).toBe(9);
  await controller.pcDesktopInput({ windowId: "101", action: "click", x: 20, y: 20 });
  expect(received.some(item => (item as any).action === "click")).toBe(true);
});

test("input rejects injected keystrokes, stale windows, and unexpected coordinates", async () => {
  const controller = createPcWindowsController({ authorizer: auth(), isInteractive: async () => true,
    runHelper: async action => action === "list"
      ? [{ id: "101", title: "Document", processName: "notepad.exe" }]
      : { ok: true },
  });
  await expect(controller.pcDesktopInput({ windowId: "999", action: "key", key: "ENTER" })).rejects.toThrow("pc_access_denied");
  await expect(controller.pcDesktopInput({ windowId: "101", action: "key", key: "ENTER;exit" })).rejects.toThrow("pc_access_denied");
  await expect(controller.pcDesktopInput({ windowId: "101", action: "click", x: -500, y: 9 })).rejects.toThrow("pc_access_denied");
  await expect(controller.pcDesktopInput({ windowId: "101", action: "type", text: "{ENTER}" })).rejects.toThrow("pc_access_denied");
  await expect(controller.pcDesktopInput({ windowId: "101", action: "scroll", x: 100, y: 80, delta: 9000 })).rejects.toThrow("pc_access_denied");
  await expect(controller.pcDesktopInput({ windowId: "101", action: "scroll", x: 100, y: 80, delta: 0 })).rejects.toThrow("pc_access_denied");
});

test("desktop permits bounded scrolling, right click and named shortcuts within an approved foreground window", async () => {
  const received: unknown[] = [];
  const controller = createPcWindowsController({ authorizer: auth(), isInteractive: async () => true,
    runHelper: async (action, args) => {
      if (action === "list") return [{ id: "101", title: "Document", processName: "notepad.exe" }];
      received.push({ action, args });
      return { ok: true };
    },
  });
  await controller.pcDesktopInput({ windowId: "101", action: "scroll", x: 100, y: 80, delta: -360 });
  await controller.pcDesktopInput({ windowId: "101", action: "right_click", x: 100, y: 80 });
  await controller.pcDesktopInput({ windowId: "101", action: "key", key: "CTRL+F" });
  expect(received).toContainEqual({ action: "scroll", args: { windowId: "101", x: 100, y: 80, delta: -360, processName: "notepad.exe", title: "Document" } });
  expect(received.some(item => (item as any).action === "right_click")).toBe(true);
  expect(received.some(item => (item as any).args.key === "CTRL+F")).toBe(true);
});
