export const PC_PROFILE_IDS = ['pc2-normal', 'pc2-dev'] as const;
export type PcProfileId = typeof PC_PROFILE_IDS[number];
export const PC_PERMISSIONS = ['status','files.read','files.write','jobs','terminal.exec','screen.read','desktop.input','desktop.advanced','apps.launch','screen.full','adb','runner','browser','chrome.user'] as const;
export type PcPermission = typeof PC_PERMISSIONS[number];
/** Issued only through the trusted local launcher, never an MCP argument. */
export interface PcGrant {
  profileId: PcProfileId;
  id: string;
  expiresAt: number | null;
  /** Signed launcher-only scope; never accepted for the DEV profile. */
  fullAccess?: boolean;
  roots: string[];
  permissions: PcPermission[];
  allowedApps: string[];
}
export interface PcStatus { enabled: boolean; expiresAt?: number | null }
/** Local host dependency; implementations must validate OS protection before returning bytes. */
export interface PcPrivateFileReader { readPrivateFile(path: string, maxBytes: number): Buffer }
