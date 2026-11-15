# Normal PC2 security foundation (Task 3/6)

This change adds security primitives to the isolated 5.0.96 checkout. It does not
register PC tools, change `main.cjs`, modify routing, migrate profiles, start the
launcher, or update an installed application. The existing six MCP tools remain
the product interface. Wiring these primitives into execution is Task 4 work.

## Trust and profile boundaries

- `pc-profile-policy.cjs` maps trusted launcher kinds to `pc2-normal` and
  `pc2-dev`; both default to disabled. Profile identity must never come from MCP
  arguments. Approvals start with a one-hour selection and a two-hour maximum;
  perpetual approval requires an explicit local confirmation and working storage.
- Normal stores its encrypted selection at
  `<userData>/pc-control/pc2-normal/pc-permanent-consent.enc`; DEV has a separate
  `pc2-dev` directory even when home directories coincide. Runtime channel paths
  are `<coreHome>/runtime/<profileId>`. Create private parent directories in order
  before initializing these paths; the ACL helper does not recursively traverse
  or silently repair an existing insecure tree.
- `pc-consent.cjs` accepts a local confirmation callback, serializes dialogs,
  invalidates pending approvals on revoke, and requires a store-issued restore
  receipt. An MCP request cannot supply that callback or a restore receipt.
- `authorization.ts` starts without a grant; rejects foreign profiles, invalid or
  expired grants and duplicate permissions; clones values at its API boundary;
  and remembers grant IDs to prevent replay after revoke within its lifetime.
- Permissions are independent: `files.read`, `files.write`, `jobs`,
  `terminal.exec`, `screen.read`, `desktop.input`, `adb`, `runner`.
  `PC_PERMISSION_DETAILS` contains local UI titles and actual risk descriptions.
  Terminal execution also requires `jobs`; process execution is **not a sandbox**.
  File roots do not constrain what a spawned Windows process can access.
- Profiles under the same Windows user are logical application boundaries, not
  protection against malicious code already running as that user. Administrators
  and SYSTEM remain trusted. HMAC is useful only while its local key is private.

## Protected storage and consent transport

`private-acl-native.cjs` calls Windows APIs through Bun FFI. New files/directories
receive a protected DACL at creation: full control for the current user's SID,
SYSTEM, and Administrators only (inheritance for directories only). Existing
objects must match that owner/DACL policy exactly. Broad or inherited access is
rejected before secret writing. This code grants no privileges and adds no broad
Deny ACE. ACL evidence is read from open handles with `GetSecurityInfo`.

Ancestor directory handles exclude share-delete, and reparse points are rejected.
Private reads validate the parent and file, have size bounds, and do not follow a
junction. Atomic writes create a private random sibling, flush it, replace the
destination on the same volume, and revalidate the final ACL. These controls are
not protection against malicious code running with the trusted SID or admin rights.

`private-acl.cjs` is the Node/Electron adapter. It requires a trusted absolute
`bunPath`, uses `shell:false`, and runs only the fixed helper. There is no PATH
fallback. Packaging must include the verified Bun runtime and unpack both
`private-acl-cli.cjs` and `private-acl-native.cjs` from ASAR; this packaging/wiring
has not been implemented or tested here. Direct Bun consumers use the native
module. No PowerShell execution-policy change is needed. The original scripted
backend encountered the machine's script policy; the user explicitly approved
the native Windows replacement. No `Bypass` was used.

`createWindowsDpapiProtection` uses CurrentUser DPAPI with profile-specific
entropy and `CRYPTPROTECT_UI_FORBIDDEN`; it does not use LocalMachine scope.
DPAPI output is copied before `LocalFree`. `pc-persistent-consent.cjs` stores
schema 2 with a profile ID, returns no approval if protection or reading fails,
and privately quarantines invalid encrypted content. Failed protection does not
overwrite an existing selection. Revocation first invalidates in-memory receipts
and atomically replaces the saved approval with an encrypted `revoked: true`
tombstone; it does not depend on deleting the old file. A newly constructed store
also rejects that tombstone. If no durable write is possible, restore stays
suppressed in the current instance, the controller reports
`persistentRevocationPending: true`, and further approval is refused until a
successful local revoke retry. A new process cannot infer an unwritten event:
Task 4 must keep the profile in maintenance, repair storage and durably retry
revocation before allowing restart/restore. No cross-restart guarantee is claimed
when all durable writes fail. A schema-1 DEV record may be read only with an
explicit DEV opt-in, never by normal, and is not rewritten. The generated legacy
fixture test is not proof that a real Electron safeStorage legacy file has migrated.

`pc-consent-channel.cjs` creates a fresh HMAC key and starts with no grant. Its
schema-2 payload includes the profile ID, heartbeat and grant. The private reader
in `consent-sync.ts` verifies profile, signature, shape, key rotation and freshness
(15 seconds, two seconds future tolerance). On loss of freshness it revokes access
before running cleanup. A heartbeat interruption renews only the transport grant
ID, not scopes or expiry. Cleanup failures cannot restore permission.

## Host resource coordination

`resource-locks.ts` implements a deliberately conservative machine-wide control
lease for jobs, terminals, desktop input and ADB. Both profiles must use the same
private local lock directory and `pc-host-control-v1` protocol. The first version
uses one coarse lock, so different ADB devices are serialized too. Screen-only
read and file access are outside this lease's input-control scope.

- A lease never supplies permission: the matching authorizer is checked before
  locking and while waiting. A changed approval cannot inherit a pending request.
- A Windows file opened with share mode zero selects exactly one process. A
  flushed journal records profile, grant, operation, PID, creation time and a
  random generation. A wait is cancellable and bounded to 30 seconds; default is
  an immediate busy result. A lease has no stealing TTL.
- Release requires a trusted local completion promise. A rejected proof keeps
  ownership, and repeated release calls share the same pending result. The
  caller in Task 4 must bind this promise to **all** contained processes exiting,
  including descendants, using Windows Job Objects or equivalent containment.
  A caller-created `Promise.resolve()` is not real process-exit evidence.
- If the owner crashes, Windows releases the OS handle but the `held` journal
  remains. Acquisition fails closed with `pc_resource_recovery_required`.
  Recovery requires the same profile, matching generation, local confirmation,
  completion proof, and an owner that is dead or has a different creation time.
  Unknown process state fails closed. Recovery kills no processes and deletes no
  foreign record. Corrupt journals require separate local maintenance.
- `resource-protocol.ts` requires trusted, complete evidence for both profiles.
  An active peer must advertise this protocol; missing, unknown or legacy peers
  prevent acquisition. Real peer discovery is a required Task 4 integration.
  A remote claim of `inactive` is never sufficient evidence.

**The installed DEV 5.0.94 does not implement this protocol.** The new code does
not make it cooperate. Keep physical control disabled while it is active unless
an independently approved DEV compatibility patch supplies the same lock and
trustworthy peer discovery. That patch must preserve its encrypted selection and
`expiresAt: null`. No such live patch has been made.

## Existing-profile ACL migration (not executed)

1. Inventory exact sensitive paths without logging content. Record owner, DACL,
   reparse status, hashes, and active writers. Use the verified encrypted backup.
2. Request local maintenance after active tasks drain; stop only the approved
   profile's writers during a future release window. Do not migrate a live file.
3. Create new private parent/profile directories and verify them. Read each
   legacy value only via the approved migration path; create a private sibling
   with the correct DACL, then replace atomically and verify the final handle.
4. Keep schema-1 DEV data unchanged unless the independently approved DEV
   migration explicitly calls for it. Never copy its approval to normal.
5. Verify startup, deny-by-default normal, local approve/revoke, ACL and routing.
   If validation fails, keep PC access disabled and restore the approved backup
   in a controlled window. Do not silently fall back to plaintext or broad ACLs.

Rollback here is simply leaving these unintegrated source additions unused.
Installed binaries/configuration have not been changed. The backup restore and
real updater rollback are not exercised by this task.

## Verification and remaining integration

New tests cover real CurrentUser DPAPI, native DACL/independent `icacls` evidence,
junction escape, root confinement, profile mismatch, replay, expiry, signature
tampering, safe-storage outage, revoked dialogs, cleanup rejection, real Windows
process races, crash journals and PID creation-time checks. The isolated MCP test
asserts all six tool names, argument keys and the turn-token bounds.

Tests run with synthetic private temp directories and isolated Codex/launcher
homes. No real desktop input, ADB action, user-grant reset or live migration is
part of those tests. Full results and initial failures are recorded in the Task 3
delivery report; ignored local logs are in `.cache/task3-security/`.
Windows-only imports and fixture probes are guarded before test registration.
The non-Windows discovery branch is simulated locally; actual Linux/macOS CI
execution is still required and has not been run on this Windows machine.

Task 4 must wire local UI and lifecycle hooks, prepare private directories, pin
the native runtime and helper layout, authenticate peer discovery, bind process
exit to containment, and route every relevant tool through authorization and
resource leases. File operations must recheck authorization and defend against
path races at the actual I/O boundary; `paths.ts` alone is not an atomic file API.
No PC MCP endpoint, real launcher integration, Electron packaging, CLI-version
matrix, real ACL migration or live rollback is claimed as tested here.

Windows API references: [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo),
[GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).
