# Feno Bridge 5.1.35

Browser turns no longer fail with "ChatGPT opened another user turn while the bound assistant
response was detached" when ChatGPT returns the submitted user turn under a new identity as the
answer settles. From 21.11 to 24.11 this failed 20 of 86 turns (none of the 179 before),
including two of three subagents in the 24.11 chat-started Codex task. Codex receives it as a
submitted-turn failure and does not retry it.

The returned user turn is accepted as the submitted one only when it is the single user turn
new since the baseline, the identity that acknowledged Send is gone, and it shares its exchange
key with every new response. A user turn in another exchange, or a second new one, still fails.
The error now lists the identities by shape (ChatGPT placeholder keys kept, real keys hashed),
so a recurrence can be measured from the diagnostics.

Validation: `bun run verify` on Windows, plus the CI matrix. Live check after install: repeat
the three-subagent task from a normal chat and confirm no turn ends with this error in
`launcher.jsonl`.
