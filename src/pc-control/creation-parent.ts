import path from "node:path";
import { PcAccessDeniedError } from "./authorization";

/** Hold every Windows ancestor without FILE_SHARE_DELETE until creation completes. */
export function holdCreationParent(parent: string, allowDeleteLeaf = false): { directory: string; close(): void; removeLeaf(): void } {
  if (process.platform === "win32") {
    const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
    const library = dlopen("kernel32.dll", {
      CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
      CloseHandle: { args: ["u64"], returns: "bool" },
      SetFileInformationByHandle: { args: ["u64", "u32", "ptr", "u32"], returns: "bool" },
    });
    const handles: bigint[] = [];
    const close = () => { for (const handle of handles.reverse()) library.symbols.CloseHandle(handle); library.close(); };
    try {
      const ancestors: string[] = [];
      for (let current = parent;; current = path.dirname(current)) {
        ancestors.unshift(current);
        if (path.dirname(current) === current) break;
      }
      for (const directory of ancestors) {
        const handle = library.symbols.CreateFileW(Buffer.from(`${directory}\0`, "utf16le"),
          0x80000000 | (allowDeleteLeaf && directory === parent ? 0x10000 : 0), 0x1 | 0x2, null, 3, 0x02000000, null);
        if (handle === 0xffffffffffffffffn || handle === 0n) throw new PcAccessDeniedError();
        handles.push(handle);
      }
      return { directory: parent, close, removeLeaf() {
        const disposition = Buffer.alloc(4); disposition.writeInt32LE(1);
        if (!allowDeleteLeaf || !library.symbols.SetFileInformationByHandle(handles[handles.length - 1]!, 4, disposition, 4)) {
          throw new PcAccessDeniedError();
        }
      } };
    } catch { close(); throw new PcAccessDeniedError(); }
  }
  throw new PcAccessDeniedError();
}
