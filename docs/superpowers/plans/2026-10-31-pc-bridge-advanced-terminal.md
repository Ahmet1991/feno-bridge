# Akentek PC Bridge Advanced Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tek seferlik ayrı yerel onayla gelişmiş Windows terminalini proje iş akışlarında kullanılabilir kılmak.

**Architecture:** Introduce `terminal.exec` into the locally approved permission list. A dedicated MCP command checks both this and `jobs`, then launches a noninteractive PowerShell child through the bounded job manager. The existing status/log/cancel and emergency revoke paths remain authoritative.

**Tech Stack:** TypeScript, Bun tests, Node child_process, Electron local consent.

**Spec:** `docs/superpowers/specs/2026-10-31-pc-bridge-advanced-terminal-design.md`

## Global Constraints

- Default deny, no remote grant setter, no change to normal Feno / Codex settings.
- Exact local `terminal.exec` and `jobs` grant necessary.
- Windows only, bounded duration/output, no UAC elevation.
- Do not claim project-root OS containment or deploy/install without local approval.

## Review Focus

- Existing permanent `jobs` grant without terminal permission: deny.
- Expired/revoked grant after terminal start: kill process tree and deny logs.
- Terminal job started under wrong project root: deny.
- Missing Windows PowerShell binary / non-Windows host: deny.
- Command accidentally included in logs: redact likely secrets, keep hash.

---

### Task 1: Local permission gate and MCP contract

**Files:** `src/pc-control/types.ts`, `src/pc-control/authorization.ts`, `launcher/electron/pc-consent.cjs`, `src/pc-control/mcp-tools.ts`, `tests/pc-mcp.test.ts`, `tests/pc-authorization.test.ts`, `launcher/tests/pc-consent.test.cjs`

- [ ] Write failing tests: terminal tool denied without new permission, granted through local consent only, and visible in tool list.
- [ ] Run focused tests and verify failure.
- [ ] Add permission and MCP schema; retain existing job isolation.
- [ ] Re-run focused tests to green.

### Task 2: Bounded execution and audit

**Files:** `src/pc-control/jobs.ts`, `src/pc-control/mcp-tools.ts`, `tests/pc-jobs.test.ts`, `tests/pc-developer-tasks.test.ts`

- [ ] Write failing tests for fixed executable, noninteractive args, working-directory validation, single-session limit, timeout and revocation.
- [ ] Verify tests fail for the expected missing functionality.
- [ ] Implement direct child spawn without shell wrapper, register job ownership, redaction, audit callback and termination.
- [ ] Run focused PC tests and typecheck.

### Task 3: Local UI handoff and regression check

**Files:** `launcher/src/App.tsx`, `launcher/electron/main.cjs`, `launcher/tests/pc-ui.test.cjs`, `launcher/tests/pc-consent.test.cjs`

- [ ] Require a distinct local user-controlled advanced-terminal approval and explicit high-risk warning; default OFF.
- [ ] Verify launcher tests, typecheck and PC tests.
- [ ] Document deployment blocker: reconcile local DEV persistence changes with GitHub branch before installation.
