# Akentek PC Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Feno Bridge `Codex Native2` MCP tunnel so an ordinary ChatGPT conversation can securely observe and, after local consent, operate Ahmet Can's Windows workstation, development projects, GitHub runner and Android TV emulator without an active Codex turn.

**Architecture:** Preserve all existing `codex_*` tools and their `turn_token` broker. Register independent `pc_*` tools in the same stdio MCP server and dispatch them to a new workstation policy and execution module. The Electron launcher owns local, expiring permissions and a kill switch; long-running tasks are polled as jobs rather than occupying the tunnel request.

**Tech Stack:** TypeScript, Bun 1.4, `@modelcontextprotocol/sdk` 1.31+, Electron launcher CommonJS, Windows user-session APIs, Android SDK `adb`, GitHub Actions self-hosted runner, `bun:test`.

**Spec:** [Akentek PC Bridge design](https://chatgpt.com/library?file_id=libfile_02c71a097eb08191b683521f7928b3a6&account_id=personal) (`akentek-pc-bridge-design.md`); copy into `docs/superpowers/specs/2026-10-30-akentek-pc-bridge-design.md` in the implementation branch before code changes.

## Global Constraints

- Work in `Ahmet1991/feno-bridge` on an isolated feature branch. Do not edit `src/chatgpt-session.ts`.
- Preserve the current `Codex Native2` MCP tool names, schemas, `turn_token` claim and broker behavior. Do not change the existing tunnel identity or Codex route.
- PC control is disabled by default; a ChatGPT tool call can never grant itself permission. No inbound router port is opened.
- Windows GUI commands operate only in the user's interactive, unlocked session and cannot bypass UAC.
- Initial write scope is explicitly approved project roots (starting with the actual Fenotip Android project path verified on PC). No implicit whole-disk access.
- No changes to `webos/` or production web deployment; no production release without separate user approval.
- CI build first, security second, player stability third; confirm existing `fenotip-tv` runner configuration before changing it.
- Repository source package says v5.0.94. Validate installed Feno, tunnel readiness, actual Android SDK path and runner status on the target PC before making runtime changes.
- Do not expose cookies, tunnel credentials, bearer tokens, API keys, passwords or raw browser profiles in logs, tool results or screenshots.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/pc-control/types.ts` | Shared operation, permission, status and job result contracts |
| `src/pc-control/authorization.ts` | Expiring grants, default-deny policy and capability checks |
| `src/pc-control/paths.ts` | Windows path canonicalization and project-root enforcement |
| `src/pc-control/files.ts` | Bounded file listing/reading and atomic patch application |
| `src/pc-control/jobs.ts` | Allowlisted commands, managed process sessions, status/log/cancel |
| `src/pc-control/windows.ts` | Window discovery, screenshot, mouse and keyboard with session checks |
| `src/pc-control/adb.ts` | Explicit ADB device selection, screenshots and input operations |
| `src/pc-control/runner.ts` | Existing runner health and known CI workflow status |
| `src/pc-control/mcp-tools.ts` | Namespaced MCP registration and validation; not Codex broker implementation |
| `src/adapters/chatgpt-web/mcp-server.ts` | One additive call to `registerPcTools`; preserve old registrations |
| `launcher/electron/pc-consent.cjs` | Local consent state, desktop confirmation, revoke and audit bridge |
| `launcher/electron/main.cjs`, `preload.cjs`, `launcher/src/App.tsx` | PC-control toggle, allowed scope and emergency stop |
| `tests/pc-*.test.ts`, `launcher/tests/pc-consent.test.cjs` | Contract, security, lifecycle and command tests |

## Review Focus

1. **Wrong/expired permission:** Every tool except disabled status must return `pc_access_denied` and cause no side effects; Task 1 test.
2. **Windows junction and path case escape:** Deny traversal outside approved canonical roots, including missing target files; Task 2 test.
3. **Concurrent build and emulator use:** One job cannot attach to or corrupt an emulator reserved by another; Task 4 test.
4. **Untrusted window title/keystrokes:** Whitelist valid target windows and keys; never interpolate arbitrary strings into PowerShell syntax; Task 5 test.
5. **Tunnel loss/reconnect or Codex regression:** `pc_*` fails closed during disconnect and the original `codex_*` tool contract is unchanged; Task 7 tests.

---

### Task 1: PC Access Policy and Local Consent

**Files:**
- Create: `src/pc-control/types.ts`, `src/pc-control/authorization.ts`
- Create: `launcher/electron/pc-consent.cjs`
- Test: `tests/pc-authorization.test.ts`, `launcher/tests/pc-consent.test.cjs`

**Interfaces:**
- Produces: `type PcPermission = 'status' | 'files.read' | 'files.write' | 'jobs' | 'screen.read' | 'desktop.input' | 'adb' | 'runner'`.
- Produces: `type PcGrant = { id: string; expiresAt: number; roots: string[]; permissions: PcPermission[]; allowedApps: string[] }`.
- Produces: `class PcAuthorizer { setGrantFromLocalApproval(grant: PcGrant): void; revoke(): void; assert(permission: PcPermission, now?: number): PcGrant; status(now?: number): {enabled:boolean;expiresAt?:number} }`.
- Produces: launcher function `createPcConsentController({clock, confirmLocally, audit})`, exposing `approve`, `status`, `revoke`; MCP must not call `approve`.

- [ ] **Step 1: Write failing tests.** Assert default disabled; expired and revoked grants reject with `pc_access_denied`; only local controller can approve; no key/secret leaks in denied or audit results; the `status` permission has no side effects.
- [ ] **Step 2: Run tests and record expected failures.** `bun test tests/pc-authorization.test.ts` and `bun test launcher/tests/pc-consent.test.cjs` must fail because the new modules do not exist.
- [ ] **Step 3: Implement the interfaces.** Use in-memory grants, explicit local approval, fixed maximum consent duration of 2 hours, and monotonic single-process revocation; do not persist grants across restart.
- [ ] **Step 4: Verify tests pass.** Run the two test files, `bun run typecheck`, and `bun run launcher:typecheck`.
- [ ] **Step 5: Commit.** `git add src/pc-control/types.ts src/pc-control/authorization.ts launcher/electron/pc-consent.cjs tests/pc-authorization.test.ts launcher/tests/pc-consent.test.cjs && git commit -m "feat(pc): introduce locally approved access policy"`.

### Task 2: Canonical File-Scope Enforcement

**Files:**
- Create: `src/pc-control/paths.ts`, `src/pc-control/files.ts`, `tests/pc-files.test.ts`
- Depends on: Task 1 `PcAuthorizer`.

**Interfaces:**
- Produces: `resolveAllowedPath(requested: string, roots: string[], {forCreate=false}: {forCreate?: boolean}): string`.
- Produces: `listPcFiles(root: string, relativePath: string, authorizer: PcAuthorizer): Promise<{name:string;kind:'file'|'directory'}[]>`.
- Produces: `readPcFile(path: string, authorizer: PcAuthorizer): Promise<{path:string;content:string;sha256:string}>`.
- Produces: `applyPcPatch(path: string, expectedSha256: string, patch: string, authorizer: PcAuthorizer): Promise<{path:string;newSha256:string}>`.

- [ ] **Step 1: Write failing tests.** Under Windows assert case-insensitive canonical roots, `..`, junction/symlink and alternate-drive escapes denied, create target parent canonicalized; all platforms enforce literal safe roots. Reject oversized reads, binary files, invalid patch, stale SHA, and write without permission without changing bytes.
- [ ] **Step 2: Run `bun test tests/pc-files.test.ts`; verify failure** on absent implementations.
- [ ] **Step 3: Implement exact functions.** Limit text reads to 2 MiB, directory entries to 500, use atomic replacement and SHA guard for patches; inspect and validate file parents immediately before write.
- [ ] **Step 4: Run `bun test tests/pc-files.test.ts` and `bun run typecheck`; verify pass** including Windows-specific tests on Windows CI.
- [ ] **Step 5: Commit.** `git add src/pc-control/paths.ts src/pc-control/files.ts tests/pc-files.test.ts && git commit -m "feat(pc): enforce scoped file access"`.

### Task 3: Register Independent `pc_*` MCP Tools

**Files:**
- Create: `src/pc-control/mcp-tools.ts`, `tests/pc-mcp.test.ts`
- Modify: `src/adapters/chatgpt-web/mcp-server.ts`
- Test existing: `tests/zero-risk-mcp-lifecycle.test.ts`, `tests/turn-token-shape.test.ts`
- Depends on: Tasks 1 and 2.

**Interfaces:**
- Produces: `interface PcHost { status(): Promise<unknown>; listFiles(path:string):Promise<unknown>; readFile(path:string):Promise<unknown>; applyPatch(path:string,sha256:string,patch:string):Promise<unknown> }` in `src/pc-control/mcp-tools.ts`.
- Produces: `registerPcTools(server: McpServer, deps: {authorizer: PcAuthorizer; host: PcHost}): void`; no `turn_token` input for `pc_*`.
- Existing `runChatGptMcpServer({brokerSocketPath,contract})` stays callable unchanged and registers new tools additively.
- Tools: `pc_status`, `pc_list_files`, `pc_read_file`, `pc_write_patch`; schemas use Zod and correct read/write/destructive annotations.

- [ ] **Step 1: Write failing MCP stdio-client contract tests.** `pc_status` returns disabled without a Codex token; protected tools deny until local consent; `codex_exec` still requires `turn_token`; `codex_turn_start` still requires Zero Risk request identity.
- [ ] **Step 2: Run `bun test tests/pc-mcp.test.ts` and record failures.**
- [ ] **Step 3: Implement `registerPcTools` and the additive registration.** Never touch existing `claimTurn`, `withClaimedTurn` or the Codex tool definitions. Log only redacted action metadata.
- [ ] **Step 4: Run `bun test tests/pc-mcp.test.ts tests/zero-risk-mcp-lifecycle.test.ts tests/turn-token-shape.test.ts`; verify pass.**
- [ ] **Step 5: Commit.** `git add src/pc-control/mcp-tools.ts src/adapters/chatgpt-web/mcp-server.ts tests/pc-mcp.test.ts && git commit -m "feat(pc): expose independent scoped MCP tools"`.

### Task 4: Command/Build Jobs and GitHub Runner Readout

**Files:**
- Create: `src/pc-control/jobs.ts`, `src/pc-control/runner.ts`, `tests/pc-jobs.test.ts`, `tests/pc-runner.test.ts`
- Modify: `src/pc-control/mcp-tools.ts`
- Depends on: Task 1 permissions and Task 2 paths.

**Interfaces:**
- Produces: `startPcJob(input: {kind:'typecheck'|'unit-tests'|'android-build'|'playback-smoke'; projectRoot:string}, authorizer: PcAuthorizer): Promise<{jobId:string}>`.
- Produces: `pcJobStatus(jobId:string): {state:'queued'|'running'|'succeeded'|'failed'|'cancelled';exitCode?:number}`; `pcJobLogs(jobId:string, cursor?:number): {lines:string[];nextCursor:number}`; `cancelPcJob(jobId:string): Promise<void>`.
- Produces: `getRunnerStatus(options:{label:'fenotip-tv'}): Promise<{state:'online'|'offline'|'unknown';source:string;activeJob?:string}>`.
- Tools: `pc_start_job`, `pc_job_status`, `pc_job_logs`, `pc_cancel_job`, `pc_runner_status`.

- [ ] **Step 1: Write failing tests.** Unknown job kind, root, command argument and runner label are rejected; cancellation terminates process tree; logs redact secrets; a 3-minute fake job returns an ID promptly rather than blocking MCP. Two emulator jobs cannot run concurrently.
- [ ] **Step 2: Run `bun test tests/pc-jobs.test.ts tests/pc-runner.test.ts`; verify expected failures.**
- [ ] **Step 3: Implement allowlisted `spawn` execution without general shell interpolation.** Use bounded stdout/stderr storage, job TTL, owner scope, cancellation and runner read-only probes. Resolve actual Fenotip repo/runner installation on target machine before binding commands to paths.
- [ ] **Step 4: Register job/runner tools.** Preserve existing MCP tool contracts and capture real `status`/`logs` typed results.
- [ ] **Step 5: Run focused tests and `bun run typecheck`; verify pass.**
- [ ] **Step 6: Commit.** `git add src/pc-control/jobs.ts src/pc-control/runner.ts src/pc-control/mcp-tools.ts tests/pc-jobs.test.ts tests/pc-runner.test.ts && git commit -m "feat(pc): add bounded jobs and runner status"`.

### Task 5: Windows Desktop and Android Emulator Control

**Files:**
- Create: `src/pc-control/windows.ts`, `src/pc-control/adb.ts`, `tests/pc-windows.test.ts`, `tests/pc-adb.test.ts`
- Modify: `src/pc-control/mcp-tools.ts`
- Depends on: Tasks 1 and 4.

**Interfaces:**
- Produces: `listPcWindows(): Promise<{id:string;title:string;processName:string}[]>`; `capturePcWindow(id:string): Promise<{mimeType:'image/png';data:Uint8Array}>`.
- Produces: `pcDesktopInput(input:{windowId:string;action:'click'|'key'|'type';x?:number;y?:number;key?:string;text?:string},authorizer:PcAuthorizer):Promise<{ok:true}>`.
- Produces: `adbDevices():Promise<{serial:string;state:string}[]>`; `adbInput(serial:string,input:{action:'tap'|'key'|'text';x?:number;y?:number;value?:string}):Promise<void>`; `adbScreenshot(serial:string):Promise<Uint8Array>`.
- Tools: `pc_list_windows`, `pc_capture_screen`, `pc_desktop_input`, `pc_adb_devices`, `pc_adb_input`, `pc_adb_screencap`.

- [ ] **Step 1: Write failing tests.** Reject locked/noninteractive session, missing or stale window ID, non-allowlisted app, invalid key/coordinates, unexpected ADB device, oversized image; assert no generated PowerShell code can contain user-controlled commands and each side-effect obeys permission.
- [ ] **Step 2: Run `bun test tests/pc-windows.test.ts tests/pc-adb.test.ts` and record failures.**
- [ ] **Step 3: Implement Windows UI through fixed packaged Windows API helper calls** from the logged-in user session, using validated structured arguments. Prefer existing installed Computer Use support when verified on that PC; do not assume `@oai/sky` exists outside its host. Return PNG under the tunnel's 10 MiB envelope.
- [ ] **Step 4: Implement ADB with exact `spawn` argv and serial selection;** do not expose arbitrary `adb shell` in v1. Screenshot, tap, key and text must work on the target Android TV emulator.
- [ ] **Step 5: Register UI/ADB tools and run focused tests, `bun run typecheck`; verify pass.**
- [ ] **Step 6: Commit.** `git add src/pc-control/windows.ts src/pc-control/adb.ts src/pc-control/mcp-tools.ts tests/pc-windows.test.ts tests/pc-adb.test.ts && git commit -m "feat(pc): control Windows and Android emulator"`.

### Task 6: Launcher Consent UI, Kill Switch and Local Audit

**Files:**
- Modify: `launcher/electron/main.cjs`, `launcher/electron/preload.cjs`, `launcher/src/App.tsx`, `launcher/src/types.ts`
- Create: `launcher/tests/pc-ui.test.cjs`
- Depends on: Task 1 `pc-consent.cjs`.

**Interfaces:**
- Renderer IPC: `launcher:pc-status` -> `{enabled:boolean;expiresAt?:number;roots:string[];permissions:string[]}`.
- Renderer IPC: `launcher:pc-approve` (local UI click only; duration max 2 h, roots and abilities selected); `launcher:pc-revoke` (immediate).
- MCP receives policy snapshot through a narrowly authenticated localhost channel or existing Feno-owned trusted control mechanism; a model cannot call the approval IPC.

- [ ] **Step 1: Write failing UI/IPC tests.** Missing local confirmation, forged remote caller, pre-login/locked session and stale grant cannot enable PC controls; revoke interrupts pending jobs and desktop input immediately.
- [ ] **Step 2: Run `bun test launcher/tests/pc-ui.test.cjs` and record failure.**
- [ ] **Step 3: Add one PC Control settings surface and confirm/revoke flow.** Default OFF, clearly show duration, exact roots and available actions; no persistent access toggle and no admin elevation.
- [ ] **Step 4: Wire launcher IPC to the same authorizer used by MCP with authenticated local transport.** Avoid reusing browser login tokens or expanding the existing browser control server without a bounded route.
- [ ] **Step 5: Run launcher tests, `bun run launcher:typecheck`, `bun run launcher:test`, `bun run app:smoke`; verify pass.**
- [ ] **Step 6: Commit.** `git add launcher/electron/main.cjs launcher/electron/preload.cjs launcher/src/App.tsx launcher/src/types.ts launcher/tests/pc-ui.test.cjs && git commit -m "feat(pc): add local consent and emergency revoke"`.

### Task 7: End-to-End, Regression, Packaging and Rollback

**Files:**
- Create: `tests/pc-e2e.test.ts`
- Modify: `docs/release-validation.md`, `Setup/README.md`
- Depends on: Tasks 1–6.

**Interfaces:**
- Test report contains installed Feno version, tunnel readiness, connector refresh result, runner label, emulator serial, and screenshots/log IDs **without secrets**.
- The kill switch disables `pc_*` with no change to `codex_*`; existing release updater and bridge startup remain intact.

- [ ] **Step 1: Write failing end-to-end tests.** A local MCP stdio client calls `pc_status` without `turn_token`; disabled tools reject; locally approved session reads a test file and runs a mock build; mocked emulator screen-input-screen loop works; revoked/expired permission stops controls; original Codex turn still invokes `codex_exec` only with its token.
- [ ] **Step 2: Run `bun test tests/pc-e2e.test.ts` and record the expected missing-integration failure.**
- [ ] **Step 3: Implement only missing integration; update local setup/rollback instructions.** Instruct connector refresh after new tool schema. Do not overwrite tunnel ID, key or ChatGPT profile.
- [ ] **Step 4: Run `bun run verify` and `bun run app:smoke`; verify pass.** Run Windows package smoke, then perform a separate manual authenticated ChatGPT connector call on the actual PC (without Codex turn), followed by a controlled emulator test. Record runner state and emulator evidence.
- [ ] **Step 5: Commit.** `git add tests/pc-e2e.test.ts docs/release-validation.md Setup/README.md && git commit -m "test(pc): verify ChatGPT workstation control and Codex regression"`.
- [ ] **Step 6: Prepare a PR with test evidence and rollback instructions.** Do not merge/release/install on the user's live PC until the user explicitly authorizes the deployment.

## Completion Criteria

- From an ordinary ChatGPT chat (including supported iPhone plugin use), `pc_status` works without a Codex task or token.
- With approved local access, code/test/runner/emulator actions succeed and are verifiably bounded; the GUI action loop provides fresh screenshot evidence.
- The existing Feno/Codex integration, `Codex Native2`, full-mode and Zero Risk contracts pass regression tests.
- No extra public tunnel endpoint or inbound port, no sensitive data in logs, and no unapproved live deploy.
- The user can revoke PC access at any moment; permission expiry and logout fail closed.
