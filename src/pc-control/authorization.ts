import { isAbsolute as posixIsAbsolute, parse as posixParse } from "node:path/posix";
import { isAbsolute as windowsIsAbsolute, parse as windowsParse } from "node:path/win32";
import { PC_PERMISSIONS, type PcGrant, type PcPermission, type PcStatus } from "./types";

export const MAX_PC_GRANT_MS = 2 * 60 * 60 * 1_000;
const ALLOWED_PERMISSIONS = new Set<string>(PC_PERMISSIONS);

export class PcAccessDeniedError extends Error {
  readonly code = "pc_access_denied";
  constructor() {
    super("pc_access_denied");
    this.name = "PcAccessDeniedError";
  }
}

export function validatePcGrant(grant: PcGrant, now: number): void {
  if (!grant || typeof grant !== "object"
    || typeof grant.id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(grant.id)
    || !Number.isFinite(now)
    || !Number.isSafeInteger(grant.expiresAt)
    || grant.expiresAt <= now || grant.expiresAt > now + MAX_PC_GRANT_MS
    || !Array.isArray(grant.permissions) || grant.permissions.length < 1
    || grant.permissions.length > PC_PERMISSIONS.length
    || !grant.permissions.every(value => typeof value === "string" && ALLOWED_PERMISSIONS.has(value))
    || !Array.isArray(grant.roots) || grant.roots.length > 16
    || !grant.roots.every(isValidPcRoot)
    || !Array.isArray(grant.allowedApps) || grant.allowedApps.length > 32
    || !grant.allowedApps.every(value => typeof value === "string" && /^[a-zA-Z0-9_. -]{1,100}$/.test(value))
  ) throw new PcAccessDeniedError();
}

export function isValidPcRoot(root: unknown): root is string {
  if (typeof root !== "string" || root.length < 2 || root.length > 1024 || root.includes("\0")) return false;
  if (windowsIsAbsolute(root)) {
    // The whole drive, UNC shares and device paths are not valid project scopes.
    if (root.startsWith("\\\\") || windowsParse(root).root.toLowerCase() === root.toLowerCase()) return false;
    return true;
  }
  if (posixIsAbsolute(root)) return posixParse(root).root !== root;
  return false;
}

function cloneGrant(grant: PcGrant): PcGrant {
  return {
    id: grant.id,
    expiresAt: grant.expiresAt,
    roots: [...grant.roots],
    permissions: [...grant.permissions],
    allowedApps: [...grant.allowedApps],
  };
}

/**
 * In-memory, default-deny guard. Its local-approval setter must ONLY be invoked by
 * the launcher-owned authenticated channel, never by MCP input or model arguments.
 * There is deliberately no persistent approval on process restart.
 */
export class PcAuthorizer {
  private active: PcGrant | undefined;
  private readonly seenIds = new Set<string>();
  private readonly clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  setGrantFromLocalApproval(grant: PcGrant): void {
    const now = this.clock();
    validatePcGrant(grant, now);
    if (this.seenIds.has(grant.id)) throw new PcAccessDeniedError();
    this.seenIds.add(grant.id);
    this.active = cloneGrant(grant);
  }

  revoke(): void {
    this.active = undefined;
  }

  status(now: number = this.clock()): PcStatus {
    if (!this.active || this.active.expiresAt <= now) return { enabled: false };
    return { enabled: true, expiresAt: this.active.expiresAt };
  }

  assert(permission: "status", now?: number): PcGrant | undefined;
  assert(permission: Exclude<PcPermission, "status">, now?: number): PcGrant;
  assert(permission: PcPermission, now?: number): PcGrant | undefined;
  assert(permission: PcPermission, now: number = this.clock()): PcGrant | undefined {
    if (permission === "status") return this.active && this.active.expiresAt > now ? cloneGrant(this.active) : undefined;
    if (!this.active || this.active.expiresAt <= now || !this.active.permissions.includes(permission)) {
      throw new PcAccessDeniedError();
    }
    return cloneGrant(this.active);
  }
}
