# Akentek PC Bridge Developer Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bir kez yerel izin verilmiş Akentek proje kökleri altında test/build/lint/Git görevlerini tekrar kullanıcı onayı istemeden çalıştırmak.

**Architecture:** Trusted host computes task catalogs from verified project manifests and fixed executable/argument pairs, keyed by canonical project path. The MCP exposes listing and launching by opaque task ID, while the existing job manager handles bounded execution, logs, cancellation and revocation.

**Tech Stack:** TypeScript, Bun test, MCP SDK, Node child_process, Windows Gradle wrapper.

**Spec:** `docs/superpowers/specs/2026-10-31-pc-bridge-developer-tasks-design.md`

## Global Constraints

- No arbitrary command string, shell interpolation or model-supplied executable path.
- Local `jobs` grant and canonical approved roots required before any task executes.
- Preserve existing `pc_start_job` behavior and all current tools.
- Do not alter normal Feno, Codex, `src/chatgpt-session.ts`, or the DEV persistent grant implementation on the Windows host.
- No remote installation, publication or automatic deployment.

## Review Focus

- Project outside grant root: reject before reading manifest or launching a child.
- Sibling project within a broad root: allow its own valid tasks with a separate manager.
- Untrusted script names (`deploy`, `publish`, `clean`, etc.): never advertise or run.
- Path symlink escaping the approved root: reject at canonical path validation.
- Revocation while a task is running: cancel it and reject future status/log calls.

---

### Task 1: Task catalog

**Files:** `src/pc-control/developer-tasks.ts`, `tests/pc-developer-tasks.test.ts`

**Interfaces:** `inferPcDeveloperTasks(projectRoot: string, platform?: NodeJS.Platform): Record<string, PcCommandSpec>`

- [ ] Test trusted package scripts, Android wrapper and Git read-only tasks are discoverable, while dangerous script names are not.
- [ ] Run `bun test tests/pc-developer-tasks.test.ts` and observe the expected missing-module failure.
- [ ] Implement the catalog with fixed commands, bounded manifest, and safe task-name matching.
- [ ] Re-run the focused test to green.

### Task 2: Multiple approved projects / task lifecycle

**Files:** `src/pc-control/mcp-tools.ts`, `tests/pc-mcp.test.ts`, `tests/pc-developer-tasks.test.ts`

**Interfaces:** `PcHost.listProjectTasks?(projectRoot)` and `PcHost.startProjectTask?(projectRoot, taskId)`; existing job status/log/cancel tools accept generated IDs.

- [ ] Write failing MCP tests for denied grants, permitted catalog and launch, revocation and two project roots.
- [ ] Run `bun test tests/pc-mcp.test.ts tests/pc-developer-tasks.test.ts` and verify the failures.
- [ ] Wire a canonical per-project job manager with a task catalog, shared job lookup and cancellation.
- [ ] Re-run focused tests; run full `bun test` and `bun run typecheck`.

### Task 3: Documentation and handoff

**Files:** `docs/superpowers/specs/2026-10-31-pc-bridge-developer-tasks-design.md`, `docs/superpowers/plans/2026-10-31-pc-bridge-developer-tasks.md`

- [ ] Confirm no local Windows permissions, production Feno settings, or remote deployment were changed.
- [ ] Review diff, tests, release risk and write precise one-time local installation / scope-expansion instructions.
- [ ] Commit only reviewed DEV branch changes; do not merge or deploy automatically.
