# Feno Bridge v5.0.12 Release Validation

Validation date: 2026-09-18

## Public release evidence

- Tag: `v5.0.12`
- Tag commit: `114c79f4cd572ad0877f03538675c39ae27462ad`
- Release workflow run: `35283729319`
- Workflow result: completed / success
- Workflow URL: https://github.com/Ahmet1991/feno-bridge/actions/runs/35283729319
- Release URL: https://github.com/Ahmet1991/feno-bridge/releases/tag/v5.0.12
- Release state: public, stable, non-prerelease
- Published: `2026-09-17T22:55:50Z`
- `feno-bridge-5.0.12-win-x64.exe` SHA-256: `16b8cfecd0e66ed8edea5a509c33c9d0ce5b83794e3904c81dc5ecfbe41295f2`
- `feno-bridge-setup.exe` SHA-256: `16b8cfecd0e66ed8edea5a509c33c9d0ce5b83794e3904c81dc5ecfbe41295f2`
- Anonymous latest release resolves to `v5.0.12`.
- Stable setup download returned HTTP 200.

## Source hardening validation

The updater/release hardening changes completed on 2026-09-18 are post-tag changes on `main`. The already-public `v5.0.12` release was deliberately left untouched.

Verified changes include:

- draft-first, exact-tag release publication with public-release mutation protection and exact asset/digest checks;
- exact-tag workflow SHA verification in the Windows release validator;
- updater header timeout, bounded transient retries, `Retry-After` handling, body-stall timeout, partial-file cleanup, progress reporting, cancellation propagation, and stale overlapping-check fencing;
- functional startup readiness states used by the update worker;
- Windows install-directory backup/restore recovery and equivalent old-version retention/rollback behavior on macOS/Linux;
- packaging contracts and tests updated for the new readiness and recovery behavior.

Verification completed successfully:

- Focused release/guidance tests: 10 passed, 0 failed.
- Focused updater/readiness/recovery/packaging tests: 39 passed, 0 failed, 2 platform skips.
- Updater tests after networking/readiness changes: 15 passed, 0 failed, 1 skip.
- Readiness tests: 5 passed, 0 failed.
- Recovery tests: 3 passed, 0 failed.
- Launcher typecheck: passed.
- Full `bun run verify`: exit 0.
  - Root tests: 719 passed, 0 failed.
  - Launcher tests: 330 passed, 0 failed, 2 skips.
  - Renderer build: passed.
  - Relocatable runtime smoke: `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Windows package build: `package:win` exit 0.
- Packaged launcher smoke: `PACKAGED_LAUNCHER_SMOKE_OK` on win32/x64.

## Version-collision limitation

The public `v5.0.12` tag and release existed before the updater/release hardening work was finished. Because moving or replacing an already-public release would break release immutability, the hardening changes were not force-published under the same version and the version was not silently bumped to `5.0.13`.

Therefore, the public `v5.0.12` binaries do **not** contain the post-tag hardening changes listed above. Those changes live on `main` after the `v5.0.12` tag.

## Upgrade-path limitation

A real disposable-VM test of the user-facing Update button from installed `5.0.11` to the public `5.0.12` release was **not executed**. Package and launcher smoke tests validate the packaged application and startup path, but they do not substitute for that end-to-end upgrade test.

## Codex Windows Computer Use guidance

The global `C:\Users\ahmet\.codex\AGENTS.md` already contained the required Windows Computer Use routing guidance, including the `computer-use:computer-use` skill and the `node_repl` + `@oai/sky` fallback route. No additional global guidance edit was required.
