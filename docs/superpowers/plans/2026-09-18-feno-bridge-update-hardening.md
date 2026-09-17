# Feno Bridge Update Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Feno Bridge release publication, updater networking/concurrency, post-install readiness, rollback, and validation without mutating the already-public `v5.0.12` release.

**Architecture:** Keep the existing updater, detached worker, ready-marker, guidance sync, and GitHub Actions release flow. Add narrowly scoped state/version fences and recovery helpers around those existing boundaries. The public `v5.0.12` tag/release remains immutable; these fixes are post-tag source changes until a later explicitly authorized release version exists.

**Tech Stack:** Bun/TypeScript, Node.js CommonJS, Electron 41, node:test, Bun test, GitHub Actions + GitHub CLI, electron-builder/NSIS.

**Spec:** User-supplied `Feno Bridge 5.0.12 — inceleme, iyileştirme ve yayın görevi`, received 2026-09-18.

## Global Constraints

- Do not move, replace, clobber, or republish the public `v5.0.12` tag/release.
- Do not silently bump to `5.0.13` or start a second release.
- Preserve `5.0.11` updater compatibility for the already-published first hop.
- Do not update the maintainer's currently running Feno installation during this task.
- Preserve user profile, ChatGPT session, Codex configuration, and connector data during recovery.
- Every behavioral fix follows RED → GREEN verification before broader verification.

---

### Task 1: Make release publication atomic and completion proof SHA-bound

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release-windows.ts`
- Modify: `tests/local-release.test.ts`
- Modify: `docs/release-validation.md`

**Interfaces:**
- Consumes: tag `vX.Y.Z`, local release asset inventory, GitHub release/run metadata.
- Produces: `releaseAssetsComplete(version, release, expected?)` and release-run validation that requires the exact tag commit's successful Release workflow before `YAYIN_TAMAM`.

- [ ] **Step 1: Add failing release helper tests.**

  Cover a release that has valid asset digests but is prerelease, a release whose target/tag commit does not match the expected SHA, and workflow runs where the newest unrelated/incorrect SHA succeeded while the correct SHA failed or is still running.

- [ ] **Step 2: Run `bun test tests/local-release.test.ts` and confirm the new assertions fail for the missing SHA/workflow proof.**

- [ ] **Step 3: Implement the minimal helper proof.**

  Query the annotated tag's peeled commit, list Release workflow runs for the tag, select the run whose `headSha` equals that commit, require `status=completed` and `conclusion=success`, then require the release to be public, stable, and complete. Never treat asset presence alone as completion.

- [ ] **Step 4: Change the workflow to publish last.**

  Build the complete local `checksums.txt` once, create or resume a **draft** release, reject an existing public release for that tag, upload without silently replacing public assets, compare each remote asset digest to the local manifest, verify the complete remote inventory, then execute `gh release edit ... --draft=false` as the final publishing action. Add same-tag concurrency with cancellation disabled so retries serialize rather than create competing publishers.

- [ ] **Step 5: Re-run the focused release tests and make them green.**

- [ ] **Step 6: Update `docs/release-validation.md` to describe draft-first publication and exact-SHA completion proof.**

### Task 2: Bound update networking, retry transient GETs, expose progress, and support cancellation

**Files:**
- Modify: `launcher/electron/update.cjs`
- Modify: `launcher/tests/update.test.cjs`
- Modify: `launcher/src/types.ts`
- Modify: `launcher/src/App.tsx` only if needed to render byte progress already emitted by the controller.

**Interfaces:**
- Consumes: public GitHub release/asset URLs and `AbortSignal`.
- Produces: bounded metadata/header/body-stall behavior, bounded transient retries with `Retry-After`, download progress, cleanup of partial files, and an abortable active preparation.

- [ ] **Step 1: Add failing tests for a fetch that never returns headers, a body that stalls after progress, a transient GET retry, `429 Retry-After`, explicit cancellation, and partial-file cleanup.**

- [ ] **Step 2: Run `node --test launcher/tests/update.test.cjs` and confirm each new case fails for the intended missing behavior.**

- [ ] **Step 3: Implement testable timeout/retry helpers around `checkedFetch`/downloads.**

  Use per-attempt `AbortController`s; retry only transient network/5xx/429 failures with a small bounded attempt count and bounded backoff. Do not retry SHA mismatch. Reset the body-stall timer whenever bytes arrive so slow-but-progressing downloads remain valid.

- [ ] **Step 4: Track the active download controller in `createUpdateController`.**

  `cancelInstall()` aborts the active preparation even before a worker exists, removes the partial temp tree, and returns state to the current candidate. `pending` continues to prevent a second worker.

- [ ] **Step 5: Re-run the focused updater tests and make them green.**

### Task 3: Prevent stale overlapping update checks from overwriting newer results

**Files:**
- Modify: `launcher/electron/update.cjs`
- Modify: `launcher/tests/update.test.cjs`

**Interfaces:**
- Consumes: startup/manual `checkOnce()` calls.
- Produces: only the newest check generation may update `candidate`, `checked`, or public state.

- [ ] **Step 1: Add a failing race test where check A starts first, forced check B returns `v1.2.0`, then A returns the current version.**

- [ ] **Step 2: Run the focused test and confirm the final state incorrectly becomes `up-to-date`.**

- [ ] **Step 3: Add a monotonically increasing check generation and ignore stale completion/error transitions.**

- [ ] **Step 4: Add/confirm a duplicate install test proving only one detached worker can be created.**

- [ ] **Step 5: Re-run the updater test file and make it green.**

### Task 4: Separate window visibility from functional startup readiness

**Files:**
- Modify: `launcher/electron/update-ready.cjs`
- Modify: `launcher/tests/update-ready.test.cjs`
- Modify: `launcher/electron/main.cjs`
- Modify: `launcher/electron/update-worker.cjs`

**Interfaces:**
- Consumes: launcher version, startup timestamp, runtime startup outcome, authentication availability.
- Produces: backward-compatible window marker plus a functional startup marker consumed by new workers.

- [ ] **Step 1: Add failing tests proving a legacy/window-only marker is insufficient for new full-readiness waiting, while wrong-version and stale markers remain rejected.**

- [ ] **Step 2: Add tests for `ready`, `sign-in-required`, and `repair-required` startup outcomes.**

- [ ] **Step 3: Run `node --test launcher/tests/update-ready.test.cjs` and confirm the new behavior is absent.**

- [ ] **Step 4: Extend the marker contract without breaking old readers.**

  Keep top-level `version` and `at` for old updater compatibility. Add an optional functional startup object written only after runtime startup resolves. New workers wait for this functional evidence; signed-out authentication is a usable `sign-in-required` state rather than package corruption.

- [ ] **Step 5: Wire functional marker writes into the existing `runtime.status` branches in `main.cjs`.**

- [ ] **Step 6: Re-run ready-marker and updater worker tests and make them green.**

### Task 5: Preserve a recoverable previous installation until new-version health succeeds

**Files:**
- Modify: `launcher/electron/update-worker.cjs`
- Modify: `launcher/electron/update.cjs` if job metadata needs a recovery path.
- Modify: `launcher/tests/update.test.cjs`

**Interfaces:**
- Consumes: staged installer/app, current installation path, functional startup marker.
- Produces: an installation backup/version retained until health succeeds, restoration on failure, and no profile-data deletion.

- [ ] **Step 1: Add failing worker tests for injected install failure and post-install startup failure.**

  Assert that the previous application bytes/path are recoverable and relaunched; assert that recovery never touches user profile locations.

- [ ] **Step 2: Run focused worker tests and confirm current behavior only relaunches whatever binary remains.**

- [ ] **Step 3: Implement Windows installation-directory backup/restore around NSIS execution.**

  Create the backup before invoking the installer. A backup failure aborts before mutation. Remove the backup only after functional startup health succeeds. If restore itself fails, retain the backup and log its location for manual recovery.

- [ ] **Step 4: Delay removal of the previous macOS/Linux version until new-version readiness succeeds; restore/repoint the previous version on failure.**

- [ ] **Step 5: Re-run worker tests and make them green.**

### Task 6: Preserve and install native Windows Computer Use guidance for new tasks

**Files:**
- Verify: `AGENTS.md`
- Verify: `CHATGPT.md`
- Modify preserving content: `C:\Users\ahmet\.codex\AGENTS.md`
- Verify: `launcher/tests/guidance.test.cjs`

**Interfaces:**
- Consumes: existing local/global guidance.
- Produces: a discoverable `computer-use → node_repl → @oai/sky → list_windows/list_apps → observe/action/verify` path without overwriting user custom guidance.

- [ ] **Step 1: Confirm repository `AGENTS.md` and packaged `CHATGPT.md` contain the already-published guidance.**
- [ ] **Step 2: Read the user's global `C:\Users\ahmet\.codex\AGENTS.md`; append a short native routing section only if an equivalent section is absent.**
- [ ] **Step 3: Run `node --test launcher/tests/guidance.test.cjs` to verify bundled guidance preserves user edits/conflicts.**

### Task 7: Record release evidence and run complete verification

**Files:**
- Create: `docs/release-validation-5.0.12.md`

**Interfaces:**
- Consumes: git SHA, public release metadata, test/build outputs, manual/VM evidence availability.
- Produces: an auditable distinction among source fixes, package smoke, published `v5.0.12`, and real 5.0.11→5.0.12 upgrade evidence.

- [ ] **Step 1: Run the focused updater/release/guidance tests.**
- [ ] **Step 2: Run `bun run verify`.**
- [ ] **Step 3: Run `bun run --cwd launcher package:win` and `bun run app:smoke` on the final tested commit.**
- [ ] **Step 4: Reconfirm `v5.0.12` tag SHA, workflow `35283729319`, public release state, and Windows installer/checksum digest without modifying the release.**
- [ ] **Step 5: If no disposable Windows VM is actually available, record the 5.0.11→5.0.12 public Update-button test as not executed; do not substitute package smoke for it.**
- [ ] **Step 6: Write `docs/release-validation-5.0.12.md` with the exact evidence and the version-collision limitation.**
- [ ] **Step 7: Review `git diff`, commit only task files, push `main`, and do not create or modify any release tag.**
