/** PC Bridge permissions are distinct from the Codex turn-token capabilities. */
export const PC_PERMISSIONS = [
  "status", "files.read", "files.write", "jobs", "screen.read", "desktop.input", "adb", "runner",
] as const;

export type PcPermission = (typeof PC_PERMISSIONS)[number];

/** Issued only after a confirmation on the local Windows launcher. Never an MCP input. */
export interface PcGrant {
  id: string;
  expiresAt: number;
  roots: string[];
  permissions: PcPermission[];
  allowedApps: string[];
}

export interface PcStatus {
  enabled: boolean;
  expiresAt?: number;
}
