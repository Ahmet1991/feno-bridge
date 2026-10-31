/** PC Bridge permissions are distinct from the Codex turn-token capabilities. */
export const PC_PERMISSIONS = [
  "status", "files.read", "files.write", "jobs", "terminal.exec", "screen.read", "desktop.input", "adb", "runner",
] as const;

export type PcPermission = (typeof PC_PERMISSIONS)[number];

/** Issued only after a confirmation on the local Windows launcher. Never an MCP input. */
export interface PcGrant {
  id: string;
  /** null only for a separately confirmed, locally protected persistent grant. */
  expiresAt: number | null;
  roots: string[];
  permissions: PcPermission[];
  allowedApps: string[];
}

export interface PcStatus {
  enabled: boolean;
  expiresAt?: number | null;
}
