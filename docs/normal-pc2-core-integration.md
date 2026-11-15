# Normal PC2 core integration — Task 4/6

This is source integration in the 5.0.96 worktree, not an installed update.
Native MCP adds thirteen `pc_*` tools to the existing six `codex_*` schemas.
Safe/Zero Risk registration is unchanged. Desktop, ADB, runner and browser tools
are not registered by this change.

## Consumer lifecycle

`src/pc-control/runtime.ts` creates a default-denied authorizer. It derives the
profile from locally validated config (`purpose: dev-harness` identifies DEV),
uses the Task3 profile-specific private channel, refreshes before each request
and polls at100ms while idle/jobs run. Missing/invalid config or unavailable
native security keeps approval denied without breaking Codex tool discovery.
No MCP input can set a profile, grant, callback, approval path or peer evidence.

`mcp-tools.ts` validates strict input schemas, returns controlled error codes,
and binds job ownership to profile, grant and project manager. Grant changes
detach old owners and permanently retire their managers; shared reservations
remain occupied until actual native cleanup. Channel loss/revoke/expiry stops
new requests immediately on refresh and triggers contained-job termination.
MCP transport close revokes and drains its own managers.

The thirteen tools are `pc_status`, `pc_list_files`, `pc_read_file`,
`pc_write_patch`, `pc_create_file`, `pc_create_directory`, `pc_start_job`,
`pc_list_project_tasks`, `pc_start_project_task`, `pc_start_terminal`,
`pc_job_status`, `pc_job_logs`, `pc_cancel_job`.

## Launcher

`pc-service.cjs` owns private channel/store initialization, local approval,
heartbeat, expiry, suspension, and peer publication. `registerPcIpc` requires
the exact current main webContents and mainFrame plus the existing trusted
renderer URL policy. The preload exposes five bounded local operations,
including a main-frame-only DEV retirement request with a local Electron dialog.
The settings component defaults closed and explains account-wide process risk.
Terminal needs `jobs` and `terminal.exec`; persistent selection additionally
needs explicit local confirmation and successful CurrentUser DPAPI storage.

Existing broad runtime-parent ACLs are not migrated. A new protected profile
child is created beneath them; its secrets and their immediate parent are
private and ancestor handles are fenced during I/O. Existing insecure sensitive
profile directories are rejected, never repaired silently. DEV legacy encrypted
consent is neither read nor copied by this new normal path.

The installed-runtime Bun path is obtained from the existing verified runtime;
source launcher scripts already supply an absolute Bun path. Missing trustable
runtime or PC setup failure leaves the normal launcher usable with PC disabled.
`private-acl-cli.cjs` and `private-acl-native.cjs` are marked ASAR-unpacked in
the source package configuration. Actual packaging has not been run.

Revocation writes a private encrypted denial before granting any replacement
scope. A pending dialog cannot reactivate after revoke. On durable write failure
the UI exposes maintenance status, rejects new approvals, and the source quit
flow refuses a normal exit until a successful local revoke retry. An involuntary
crash cannot persist an unwritten event: repair durable state before restart.

## Resource discovery and jobs

`pc-runtime-paths.cjs` selects one shared protected directory for both profiles:
`%LOCALAPPDATA%/Feno Bridge PC Coordination`. A trusted local
`FENO_PC_COORDINATION_DIR` override supports isolated tests/development; both
profiles must use exactly the same directory. Each launcher privately publishes
its profile, protocol, PID, process creation time and heartbeat.

`pc-resource-peers.cjs` verifies those records against actual Windows process
state and checks configured legacy browser descriptors. A missing DEV record
is unknown unless the native scan confirms that no DEV launcher is running,
the configured DEV home does not exist, and known DEV-specific installation
paths are absent; in that case it is a verified inactive `not-installed` peer.
A live record must be fresh and compatible; a dead or
reused PID can establish that particular compatible participant is inactive.

## Single-profile normal mode without DEV (Task 4 extension)

DEV is identified by launcher `--dev-profile`, with product `Feno Bridge`,
app ID `dev.codexwebgpt.launcher`, DEV home `CODEX_WEB_GPT_DEV_HOME` or
`~/.codex-chatgpt-web-dev`, and legacy descriptor
`runtime/launcher-browser.json` (from the read-only reference application).
Native Win32 Toolhelp process enumeration inspects candidate `Feno Bridge`
and `electron.exe` main process command lines through
`NtQueryInformationProcess`; an unreadable candidate returns `unknown`.
Distinct DEV-named installation directories under `%LOCALAPPDATA%/Programs`,
`%ProgramFiles%`, `%ProgramFiles(x86)%`, plus an explicit trusted
`CODEX_WEB_GPT_DEV_INSTALL_DIR` are checked without modifying them. The actual
portable DEV deployment also uses `%LOCALAPPDATA%/Akentek-PC-Bridge-DEV/`
with dated subdirectories; the *root itself*, even empty, proves an installed
legacy DEV until it is retired or removed. If `LOCALAPPDATA` is missing or
not absolute, the installation search cannot prove absence and reports
`unknown` rather than `not-installed`. The
normal and DEV profiles share the same upstream app ID and product name;
there is no separate guaranteed DEV installation identity, so a renamed or
custom DEV installation without a detectable home is an outstanding risk.

Without a DEV home, identified DEV installation or DEV process, normal can
acquire its job/terminal lease with `pc2-dev` as verified inactive
`not-installed`. A stopped legacy DEV home/install keeps jobs denied by
default. Only the normal launcher's trusted main-frame IPC and explicit local
Electron confirmation can write a reversible, profile-bound, CurrentUser
DPAPI-protected retirement receipt in the shared private ACL directory.
Malformed, wrong-profile or unreadable receipts do not authorize anything.
Retirement is effective only when the native process scan and legacy
descriptor confirm no live DEV; live uncoordinated DEV always denies new work.
Compatible protocol records retain dual-profile coordination unchanged.

Every new operation re-observes peer/process state before acquiring its host
lease. If a previously absent DEV appears during a running job, the existing
lease remains owned until native Job Object cleanup and release; subsequent
jobs/terminals are denied until compatible coordination is restored. This
is a source/runtime contract, not a claim of immediate preemption of a job
already started before DEV appeared.

The no-DEV MCP flow uses an isolated test child with a deliberately preloaded
native process-scanner replacement to simulate a computer without the actual
DEV process currently running on the developer's workstation. It validates
real signed-grant MCP stdio, start/cancel jobs, terminal exit code propagation
and protected files without writing to either live profile home. The simulated
host observation is available only in test fixtures and is never loaded by
production code. No real Electron modal approval was opened during testing.

The MCP schema contains no retirement mutation. The local modal and receipt
also depend on the current Windows account; arbitrary terminal commands have
that same account's capabilities. CurrentUser DPAPI and a per-user ACL are
not isolation against deliberately malicious programs already executing as
that user, so resisting arbitrary same-SID forgery would require stronger
OS-level identity or user-presence protections before a high-trust deployment.
A live configured legacy launcher cannot be hidden by an old compatible record.
This inventory covers the two configured local profile homes, not arbitrary
unknown installations or another Windows user. Source deployments must bind
those homes correctly. Current installed DEV5.0.94 has no compatible record;
therefore it does not participate, and jobs fail closed while evidence is absent.
This task does not claim full physical coordination with that installation.

Every job type acquires the Task3 OS host lease. Version1 is deliberately coarse:
one process operation at a time across compatible profiles, even though local
bookkeeping permits up to four reservations and one terminal. File-only calls
remain available independently. Terminal contention has an explicit busy code.

`job-native.ts` uses Win32 Job Object KILL_ON_JOB_CLOSE and the CreateProcess
JOB_LIST attribute, assigning the child atomically before execution. Only the
selected stdin/stdout/stderr handles are inherited; the job handle is not.
No shell-exit-only release, breakaway flags or uncontained fallback is used.
The OS kills all job descendants when the owner crashes. Normal completion and
cancel release the lease only after native accounting reports zero active
processes. Unknown exit observations or failed journal release retain ownership
and require maintenance rather than stealing capacity.

Jobs have a ten-minute maximum timeout, configurable downward only by trusted
local tests/callers. All jobs, including selected package/Gradle/Git tasks, have
the same containment; catalog selection is not proof that a script is safe.
Terminal and project scripts run as the Windows user and can access the network
and files outside the working directory. This is lifetime containment, not an
OS security sandbox. Native execution currently supports Windows x64 Bun only.

Output decoding is independent per stream and bounded by lines/bytes/pages.
Known secret formats, quoted and multiline values, and split chunks are masked
before retention. This is pattern-based redaction, not proof that arbitrary
program output contains no secrets. Private audit stores command SHA-256 and
redacted purpose, never the command body; it is bounded to1MiB and serialized
by the common host lease.

## File operations

`files.ts` checks the exact current grant before side effects and after async
boundaries. Its native backend uses pinned, reparse-checked ancestor/leaf
handles and handle-relative NT opens/renames with normal access checks. It
rejects symlinks, junctions, hardlink aliases, out-of-root paths, repository
internals and sensitive names/content. Text, listing and patch sizes are bounded.

Creation stages private data and publishes without overwriting an existing
object. Patch checks the supplied SHA-256, keeps line terminators/BOM, rechecks
the file identity/hash immediately before atomic replacement and verifies
readback. A named per-file mutex coordinates compatible concurrent writers.
The replacement retains the private staging ACL; legacy source-file ACLs are
not copied. No live project permission migration was performed.

Ordinary Windows rename is not a hostile same-SID external editor CAS. Other
trusted-user applications do not participate in our mutex; do not claim complete
adversarial CAS against them. Pre-publication errors preserve the original.
An exceptional failure after atomic publication may report failure after a
complete replacement and cannot promise rollback; no partial file is advertised
as success. There is no general file-delete tool in this task.

## Evidence and release gates

Tests use fresh temp profiles, native Windows child/grandchild fixtures and real
MCP stdio sessions. The full delivery report records exact counts and initial
failures. UI coverage includes real service/IPC behavior and initial React
render; no real Electron window or live consent dialog was opened.

### Running tests on Windows (Defender)

Microsoft Defender detected `Behavior:Win32/SuspBunActivity.A` during combined
root + launcher runs and terminated the parent Node process or quarantined
temporary Bun test fixtures. Run the eight verification gates as **separate
shell-level Node processes**, in order: `focused`, `root`, `launcher`,
`root-typecheck`, `launcher-typecheck`, `version`, `git-diff-check`, and
`untracked-whitespace`. For each name run
`node .cache/task4/run-final.cjs --gate <name>`; stop on the first nonzero exit
code. Then run `node .cache/task4/run-final.cjs --summary` to inspect the
aggregated counts and final exit status. Starting with `focused` resets the
previous summary. Do not use the legacy one-call run (not recommended due to
Defender behavior), or the former `--resume-after-root` option. Do not disable
Defender or add exclusions to make tests pass. Compare read-only
`Get-MpThreatDetection` counts and detection times before/after verification.

Before deployment: run actual packaging/ASAR smoke and both CLI versions, actual
Linux/macOS/ARM64 matrix as applicable, ACL migration/rollback rehearsal, and
legacy DEV compatibility work. Task5 must complete desktop/ADB/browser work and
their input/resource binding. Current changes remain in the isolated worktree;
no live application, tunnel, settings, approval or routing was changed.
