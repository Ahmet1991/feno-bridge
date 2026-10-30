import { describe, expect, test } from "bun:test";
import { PcAuthorizer, PcAccessDeniedError, MAX_PC_GRANT_MS } from "../src/pc-control/authorization";
import type { PcGrant } from "../src/pc-control/types";

const NOW = 1_800_000_000_000;
function grant(overrides: Partial<PcGrant> = {}): PcGrant {
  return {
    id: "approved-local-session-1",
    expiresAt: NOW + 60_000,
    roots: ["D:\\GitHub\\Fenotip"],
    permissions: ["status", "files.read", "jobs"],
    allowedApps: [],
    ...overrides,
  };
}

describe("PC authorization is independent and default-deny", () => {
  test("only disabled status can be read without consent", () => {
    const policy = new PcAuthorizer({ clock: () => NOW });
    expect(policy.status()).toEqual({ enabled: false });
    expect(policy.assert("status")).toBeUndefined();
    for (const permission of ["files.read", "files.write", "jobs", "screen.read", "desktop.input", "adb", "runner"] as const) {
      expect(() => policy.assert(permission)).toThrow(PcAccessDeniedError);
      expect(() => policy.assert(permission)).toThrow("pc_access_denied");
    }
    expect(policy.status()).toEqual({ enabled: false });
  });

  test("local approval allows only the named capabilities, before expiration", () => {
    const policy = new PcAuthorizer({ clock: () => NOW });
    policy.setGrantFromLocalApproval(grant());
    expect(policy.status()).toEqual({ enabled: true, expiresAt: NOW + 60_000 });
    expect(policy.assert("files.read").roots).toEqual(["D:\\GitHub\\Fenotip"]);
    expect(() => policy.assert("files.write")).toThrow("pc_access_denied");
    expect(() => policy.assert("files.read", NOW + 60_000)).toThrow("pc_access_denied");
    expect(policy.status(NOW + 60_000)).toEqual({ enabled: false });
  });

  test("revocation invalidates the grant and prevents its replay", () => {
    const policy = new PcAuthorizer({ clock: () => NOW });
    const accepted = grant();
    policy.setGrantFromLocalApproval(accepted);
    policy.revoke();
    expect(() => policy.assert("jobs")).toThrow("pc_access_denied");
    expect(() => policy.setGrantFromLocalApproval(accepted)).toThrow("pc_access_denied");
    policy.setGrantFromLocalApproval(grant({ id: "new-local-confirmation" }));
    expect(policy.assert("jobs").id).toBe("new-local-confirmation");
  });

  test("rejects excessive lifetime, malformed roots and permissions, without leaking IDs", () => {
    const policy = new PcAuthorizer({ clock: () => NOW });
    const secret = "Bearer SECRET_TOKEN_SHOULD_NOT_BE_LOGGED";
    for (const invalid of [
      grant({ expiresAt: NOW + MAX_PC_GRANT_MS + 1 }),
      grant({ expiresAt: NOW }),
      grant({ roots: [""] }),
      grant({ roots: [secret] }),
      grant({ permissions: ["arbitrary.shell" as any] }),
      grant({ id: secret }),
    ]) {
      try {
        policy.setGrantFromLocalApproval(invalid);
        throw new Error("invalid grant accepted");
      } catch (error) {
        expect(String(error)).not.toContain(secret);
        expect(String(error)).toContain("pc_access_denied");
      }
    }
    expect(policy.status()).toEqual({ enabled: false });
  });

  test("callers cannot mutate the accepted grant by retaining a reference", () => {
    const policy = new PcAuthorizer({ clock: () => NOW });
    const approved = grant();
    policy.setGrantFromLocalApproval(approved);
    approved.permissions.push("files.write");
    approved.roots.push("C:\\");
    const returned = policy.assert("files.read");
    returned.permissions.push("files.write");
    expect(() => policy.assert("files.write")).toThrow("pc_access_denied");
    expect(policy.assert("files.read").roots).toEqual(["D:\\GitHub\\Fenotip"]);
  });
});
