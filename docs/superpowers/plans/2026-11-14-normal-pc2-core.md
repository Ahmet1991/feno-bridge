# Normal PC2 core integration implementation plan

> For agentic workers: use explicit independent-domain ownership and TDD; one fresh whole-change security review at the end. No nested delegation.

**Goal:** Add 13 file/job/status MCP tools and local launcher approval to the 5.0.96 worktree, preserving all six Codex tools and live installations.

**Spec:** User's Task 4/6 request in this chat; Task 2–3 reports in the projectless outputs folder and `docs/normal-pc2-security.md` supply inherited security requirements.

**Architecture:** Keep existing broker tools untouched. Add an authenticated per-profile PC runtime to native MCP only. Files pin Windows paths across I/O and verify hashes; jobs use native Win32 containment with atomic Job Object assignment and the Task3 lease. The launcher alone publishes approval and compatible peer evidence. Legacy/unknown peers fail closed for process execution.

**Approaches:** Blind DEV copy would regress profile/ACL controls and 5.0.96 fixes. A new remote service would unnecessarily change connector identity. Selective port into existing MCP/launcher is the chosen implementation decision, consistent with the user's specified modules. No new UI workflow for ADB/desktop/browser in this task.

## Global constraints

- Edit code only at `D:/GitHub/feno-bridge-pc-normal-next`, branch `feat/normal-pc2-next-5.0.96`; preserve Task3's uncommitted additions and unrelated work.
- No live stop/restart/config/ACL/on-consent changes, package build/install/update/deploy, push/merge/reset. No commit needed; keep changes reviewable.
- Normal starts denied; profile identity comes from trusted local launcher/config, never MCP arguments. Safe storage failure denies approval; pending durable revocation requires maintenance.
- Existing source versions/lockfiles and 5.0.96 routing opt-out, runtime/state fixes and browser-worker fixes remain.
- New tools: pc_status,list_files,read_file,write_patch,create_file,create_directory,start_job,list_project_tasks,start_project_task,start_terminal,job_status,job_logs,cancel_job.
- No desktop/ADB/runner registration here. Terminal/jobs are user-account execution, not OS sandboxing.

## Review Focus

1. File/path replacement between canonical validation and I/O: no junction escape, SHA conflict or partial write success.
2. Parent exits while descendants live: no early resource release or orphan process tree.
3. Grant/profile replacement during asynchronous job start: no ownership transfer or leaked process.
4. Lost durable revoke/store outage: immediate remote denial and visible maintenance state; no automatic restoration after failed persistence.
5. Missing/legacy peer evidence and silent routing regression: fail closed for jobs; preserve normal route opt-out and six Codex schemas.

## A — File operations (independent domain)

Files: `src/pc-control/files.ts`, native/pinning and patch helpers as necessary, `tests/pc-files*.test.ts`.
Interfaces: DEV-compatible `listPcFiles(root,relative,authorizer)`, `readPcFile(file,authorizer)`, `createPcFile(file,content,authorizer)`, `createPcDirectory(dir,authorizer)`, `applyPcPatch(file,sha,patch,authorizer)`.
- [ ] RED tests: authorized create/read/patch, SHA mismatch, LF/CRLF, sensitive names/content, root/junction escapes, concurrent/failure integrity and write readback.
- [ ] Adapt DEV algorithms; hold Windows handles across actual I/O, atomically publish new files without replacing existing ones; verify resulting bytes.
- [ ] GREEN targeted tests with actual temp files; no real user data.

## B — Jobs and containment (independent domain)

Files: `jobs.ts`, `developer-tasks.ts`, `terminal-containment.ts`, native containment helper and `tests/pc-jobs*.test.ts`/fixtures.
Interfaces: DEV-compatible manager methods `startPcJob/startDeveloperTask/startTerminalCommand/pcJobStatus/pcJobLogs/cancelPcJob/revokeAll/hasActiveTerminal/activeJobCount`; manager options additionally require `profileId` and `acquireLease(operation:'job'|'terminal',operationId:string):Promise<PcHostLease>`.
- [ ] RED actual Windows tests: exit code, timeout, cancel, grandchildren after shell exit, wrapper/owner crash, profile/grant mismatch, terminal busy, log bounds/redaction.
- [ ] Use native Win32 Job Object KILL_ON_JOB_CLOSE with atomic CreateProcess JOB_LIST assignment; no uncontained fallback or policy bypass. Contain all job types.
- [ ] Bind `releaseAfterExit` to verified zero active processes; resources survive failed cleanup. Bound every job. Pin owner/grant on every start/status/log/cancel operation.
- [ ] GREEN targeted tests; only fixture process IDs may be terminated.

## C — Local runtime/MCP and peer evidence

Files: `mcp-tools.ts`, `runtime.ts`, `resource-peers.ts`, `src/adapters/chatgpt-web/mcp-server.ts`, contract/integration tests; private ACL adapter context query if needed.
- [ ] RED actual MCP discovery/calls: 6 unchanged Codex +13 PC tools on native, unchanged safe contract, unauthorized/invalid calls, signed local fixture approval, file/job workflows.
- [ ] Register tools even when unavailable/denied; use private signed profile channel, refresh before every action and on a bounded timer, terminate old-grant jobs before accepting further execution.
- [ ] Resolve profile from locally loaded config purpose/home. Use one protected shared coordination directory. Verify registry profile/PID creation-time/heartbeat; absent/legacy peers remain unknown, never infer absence as permission.
- [ ] On close, revoke and kill contained jobs. Do not log commands/secrets; audit hashed command and redacted purpose privately.

## D — Launcher, preload and local approval UI

Files: new focused `pc-service.cjs` plus `main.cjs`, `preload.cjs`, `App.tsx`, `types.ts`, small PC settings component; source ASAR config for sidecars without building; launcher tests.
- [ ] RED tested local service lifecycle + IPC trust rejection, profile separation, local-only grant, expiry/revoke/failed write, existing route preference retained.
- [ ] Initialize new private directories in order, derive verified absolute Bun from existing trusted runtime; bind profile from `resolveLauncherProfile`.
- [ ] Prepare local dialog, project picker, separate permissions and perpetual opt-in. Clearly describe account-wide terminal authority; default disabled.
- [ ] Fail closed and keep startup usable on PC setup errors; stop heartbeat/revoke transport on shutdown/fatal startup; never reset live legacy DEV records.

## E — Verify, review, report

- [ ] Run targeted, full root and launcher suites, both typechecks, version/static/whitespace checks. No packaging or live smoke.
- [ ] One independent fresh-context read-only whole-change security review; fix in-scope Important/Critical findings with RED→GREEN tests.
- [ ] Record exact pass/fail/skip counts and untested live/CLI/platform limitations; compare before/after live PIDs and DEV persistent ciphertext hash read-only.
- [ ] Save report/evidence in projectless `outputs`, preserve worktree, stop before Task5.

## Rulings

User supplied a detailed execution request and AGENTS says ask only for genuine blockers. Proceed with the above source-only implementation decisions, rather than adding a design approval round. No irreversible/live action is authorized by this plan. Existing Task3 evidence is reused; current baseline33/33 passed. No recursive agent workflows. Source artifacts remain uncommitted as requested.
