# Feno Bridge 5.0.91 validation

Date: 2026-10-27. Windows x64; upgrade baseline 5.0.90.

## Changes

- Preserve previously authenticated auxiliary workspace roots when a cwd-less calendar update
  resolves against a native rollout that records only cwd. Verify the current rollout and reject
  workspace expansion before retaining the existing authority. Preserve whether the native record
  omitted workspace roots: an explicitly narrowed list must not retain removed authority.
- Let each connector-menu ArrowDown commit before reading its highlight or sending another key.
  Keep exact connector identity checks. Report an expired selection deadline without launching a
  misleading 1 ms DOM observation.
- Adapt upstream `miuuyy/codex-chatgpt-web@ffe041f` completion-action grace to ten minutes.
  Explicit empty completion and vanished-DOM checks retain their existing shorter limits.

## Focused evidence

- Midnight regression failed on the previous code by dropping the auxiliary root; fixed code
  preserves authority and rejects an unproven extra root. The explicit-root-removal regression also
  failed before native declaration provenance was preserved, then passed after the fix.
- Connector navigation and expired-deadline regressions each failed before the corresponding fix
  and passed afterwards.
- Connector preflight on the signed-in, idle DEV profile selected exactly Codex Native2 in 10/10
  attempts. No task message was sent, no production browser turn was cancelled.
- Upstream-style delayed-final regressions failed with the former 60-second grace and passed with
  the bounded ten-minute grace, while empty completion/lost DOM retain shorter failure windows.
- Focused browser-worker, environment and connector-DOM suite: 262 passed before the two
  delayed-final tests were added; the delayed-final file separately passed 2/2.
- Full verification passed: 1,058 core tests, 406 launcher tests, zero failures; audits, type checks,
  renderer build and relocated-runtime smoke passed. Three tests in each suite were skipped.
  This run preceded the final native-root-provenance change; afterwards the 85-test environment
  suite and core type check passed. The publishing runner repeats full verification on the final
  committed tree before packaging.
- Independent source review found no remaining blocking findings after the provenance fix.

## Release gates

Full verification, package smoke, exact-SHA release workflow and public checksummed asset inventory
must be recorded by the publishing run. A tag or local package alone is not publication.
This patch does not claim a new manual macOS/Linux account-bound test or a real midnight-crossing
ChatGPT task; cross-platform package checks run in GitHub Actions.
