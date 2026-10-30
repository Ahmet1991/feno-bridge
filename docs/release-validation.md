# Release validation

## Publishing updates

On a clean `main` checkout, run `YAYINLA.bat` on Windows. It advances the patch version, verifies
the code and Windows package, then pushes one `vX.Y.Z` tag. The tag starts the GitHub Actions
Release workflow, which is the only publisher: it builds Windows, macOS, and Linux assets, copies
the versioned Windows installer to the stable `feno-bridge-setup.exe` name, and checksums every
asset. The workflow stages those exact bytes in a draft release, verifies the complete remote asset
inventory and every remote SHA-256 against the local build output, then makes the release public as
its final publishing step. Same-tag workflow retries serialize instead of replacing an already
public release. Do not create or upload a second release from the local machine.

`YAYIN_TAMAM` requires two independent facts for the exact tagged commit: its GitHub Actions
`Release` workflow completed successfully, and the public stable release exposes the required
checksummed platform assets. A successful workflow for another SHA, a draft, a prerelease, or asset
presence before the exact-SHA workflow succeeds is not release completion.

Packaged Feno Bridge installations query the latest public release on startup or when users press
**Check updates**. Once the workflow finishes, supported installations can download and verify the
new package without GitHub credentials. The local `Setup` file is a build output; share the public
release link with new users.

CI proves that the runtime builds, the launcher starts, and native packages pass their smoke
contract on macOS, Windows, and Linux. It does not prove an authenticated ChatGPT session, a live
MCP connector, or a complete Codex turn. A release candidate is not ready until those account-bound
flows are exercised manually on the platforms below.

## Required evidence

Record the release version, operating-system version, install path (`clean` or `upgrade`), ChatGPT
plan, Codex version, result of each check, and a redacted Activity log for every failure. Never
capture cookies, tunnel IDs, API keys, bearer tokens, or prompt contents.

Windows package smoke extracts the NSIS application payload into a temporary directory and
launches it with isolated launcher, runtime, and Codex profiles. It never executes the installer
or looks up the live installation in the registry. Test installer upgrade/uninstall behavior only
on a disposable Windows VM; the machine running an active bridge must not be that test target.

## Windows 11 gate

Run this list on a maintained Windows 11 x64 machine with a real ChatGPT account:

1. Install the packaged launcher on a clean profile and prove that the embedded Bun runtime starts.
2. Sign in inside the embedded browser and prove that Temporary Chat reaches a usable composer.
3. Install the Codex model route, restart Codex, and prove that every account-available ChatGPT Web
   effort appears exactly once without removing native models.
4. Complete one Browser-only turn and verify streamed commentary plus the final answer.
5. Configure the `Codex Native2` connector, run **Verify runtime**, and complete one Full-mode local
   tool turn. Repeat with Pro when the account exposes Pro.
6. Drive a chat past the compaction threshold and prove that it continues after compaction without
   a duplicate or orphaned browser turn.
7. On a clean install, prove that setup offers both interaction modes and defaults to With
   Automation. Select Zero Risk and prove that Codex shows exactly one generic Web model after
   restart, a retained chat receives only the next prompt, and
   compaction completes through MCP before the compacted continuation opens a fresh manual chat.
   Inspect the copied prompt and prove that it contains only the current `request_id`, never a
   surface nonce, capability token, or prompt-level lifecycle commands.
   Switch back to Automatic and prove that the account-visible catalog is restored.
8. Cancel a running turn by closing its launcher tab, then cancel another with the launcher action;
   prove that neither turn recreates a tab or keeps the runtime busy.
9. Quit the launcher during an active turn, confirm the explicit cancellation path, reopen it, and
   prove that the saved ChatGPT session and Codex route are still valid.
10. Prove Codex Voice can create a WebRTC call while Responses use the local bridge. Disconnect the
   bridge and prove that both exact previous route assignments are restored; reconnect it and prove
   that the existing private MCP credentials are reused rather than replaced.
11. Upgrade from the previous public release and prove that launcher state, browser state, Codex
    settings, and MCP configuration survive the updater transaction.

Any failed or unexecuted item blocks a stable release. An alpha may ship with a named failed item
only when the release notes describe the limitation and recovery path explicitly.

## Akentek PC Bridge acceptance gate (feature branch only)

PC Bridge is an additive **Codex Native2** namespace. Zero Risk keeps its original eight-tool
contract. No existing tunnel ID, route, Codex token validation or user ChatGPT profile is changed.
This feature remains OFF until the user grants access in the Windows Feno launcher.

Before installation or publishing, obtain explicit deployment approval and verify on the actual
Windows PC:

1. Record installed Feno version, launcher health and tunnel/connector visibility. Confirm the
   connector refresh presents all `pc_*` tools to an ordinary ChatGPT chat without a Codex turn.
2. Before approval, `pc_status` reports disabled and read, write, job, screenshot and input tools
   fail with `pc_access_denied`. No model tool or remote browser action may grant itself access.
3. Choose the real Fenotip Android project folder in Feno Settings. Inspect the native Windows
   confirmation and approve exactly 60 minutes. Confirm every selected permission and app.
4. Read and patch only a disposable text file inside that project using the original SHA256. Test
   rejection of sibling folders, junctions, `..`, private keys and a stale SHA256.
5. Prove typecheck and CI commands return a job ID promptly; inspect redacted logs, cancellation,
   process-tree termination and exclusive Android emulator ownership. Record the actual
   `fenotip-tv` runner label and GitHub repo before claiming runner health is online.
6. Check Windows desktop window listing, fresh PNG capture, a click and keypress in an explicitly
   allowed window, then ADB device selection, TV emulator screen/input/screen. Confirm the
   Windows helper works in the unlocked interactive session and denies locked/UAC desktops.
7. Revoke in the launcher. Confirm every PC operation immediately denies and active jobs stop.
   Repeat with expiry, forced launcher shutdown, permission-signature corruption and connector
   reconnect. After restart the PC grant must still be OFF.
8. Run the original Codex Full-mode token-gated turn and Zero Risk flow. Validate CI and Windows
   package smoke. Keep webOS, production web deploy and installed public version unchanged.

Redact all proof: never publish the HMAC key, tunnel credentials, account cookies, API tokens or
private document contents. The signed local lease is stored under the Feno runtime directory;
its local user-profile ACL is part of the Windows validation. A Windows package test is mandatory:
Linux unit tests cannot prove PowerShell `user32.dll`/WinForms desktop behavior.

**Rollback:** From Feno Settings select **Acil durdur / Revoke now**. This immediately replaces
the signed grant with a revoked snapshot; loss of launcher heartbeat also fails closed. To remove
the feature before release, revert the feature commits on its isolated branch. Do not alter the
installed tunnel identity or existing Codex configuration to roll it back.

### v3.0.0 result

Maintainer validation passed on Windows 11 x64 on 2026-08-22 using the published v3.0.0-alpha
upgrade package and a real ChatGPT Pro account. The authenticated launcher, Codex model catalog,
Full-mode MCP tools, Pro turns, compaction, cancellation, session reuse, and preserved connector
configuration were exercised successfully. The direct installer completed successfully but gave no
clear completion action; v3.0.0 changes it to an assisted installer with a final launch option.

## macOS gate

Repeat items 2 through 10 on the oldest supported macOS version or the closest maintained machine.
Packaging smoke and code-signing verification remain separate gates; neither substitutes for the
interactive account flow.

## Linux gate

CI packaging smoke is required. Before claiming interactive Linux support for a release, repeat
items 2 through 7 under a supported desktop session and record the display server and packaging
format used.
