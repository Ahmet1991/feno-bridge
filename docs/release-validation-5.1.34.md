# Feno Bridge 5.1.34

A normal ChatGPT chat with the Native connector can start a local Codex task through Feno
(`pc_codex_task_start`, `_wait`, `_list`, `_cancel`, `_logs`). The task may spawn subagents in
their own Feno tabs and returns its final message to the chat. Design and decisions:
`docs/design/sohbetten-codex-gorevi.md`.

The tools require the new `codex.tasks` permission. Full access does not include it; the
launcher adds it only while **Settings → PC → Sohbetten Codex görevi** (`pcCodexTasks`) is on.
Both that setting and the optional per-task approval (`pcCodexTasksConfirm`) default to off and
are ignored outside the production profile. Tasks are Windows-only in this release.

Tasks use a model catalog filtered to `chatgpt-web/*`, so neither the task nor its subagents can
fall back to a native model. `maxSubagents` (default 3, max 4) is capped by free Feno tabs;
the timeout defaults to 60 minutes (max 240); one chat task runs at a time. Cancel and timeout
close the whole process tree. Feno's own update and drain wait for a running task; a forced
shutdown marks it `interrupted`.

Validation: `bun run verify` on Windows, plus the CI matrix. Live checks after install: a
three-subagent task from a normal chat, a refused native-model request, Stop with no leftover
`codex.exe`, an update waiting for a running task, and `pc_codex_tabs_full` with five open tabs.
