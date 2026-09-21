# Broker image delivery: 21 September 2026

## Evidence and scope

The task's live acceptance trace `b1921056cd59` reports one browser turn opening with
`images=0 contextImages=0 requestImages=0`. The screenshot was captured after that
turn opened. The `view_image` result contained one `input_image`, and the same browser
turn continued until completion. The separate `b4b5eac45335` acceptance trace
opened a later turn with `images=1`. These observations establish that an image can
be attached at the **start** of a later browser turn; they do not establish an
automatic boundary between turns.

The read-only snapshot probe (`scripts/measure-broker-image-delivery.py`) examined
`~/.codex-chatgpt-web/responses-state.json` during this investigation. It reported
32 stored request snapshots. In the current task's request chain, entry 29 had 64
items, with one `input_image` inside the `function_call_output` at item 62; entries
30 and 31 continued to 66 and 68 items with that same image. The snapshot was
read only. It proves that native Codex kept the image in its request history. It
cannot prove that the already-running ChatGPT browser model visually received it.
The earlier `b1921056cd59` trace had already expired from this one-hour snapshot;
its original live measurements come from the supplied task record. Rollout JSONL
replay was not used as evidence.

The source also narrows the failure location. `toolResultText()` in
`window-recovery.ts` extracts only text for window-recovery and policy-stop checks.
The actual broker completion calls `brokerResult()`, which separately keeps image
parts (`{ type: "image", data, mimeType }`). The text filter alone therefore does
not explain the final visual-delivery failure. An MCP image result arriving after
the browser message has been sent is not an uploaded ChatGPT file attachment.

## Evaluation of the three approaches

1. **Force a turn boundary:** Attachment at the beginning of a new turn is
   demonstrated by the `b4b5eac45335` trace and by the existing
   `retained-image-resume.test.ts` contract. However, the current
   `runBrowserTurn()` attaches files once before `sendAttachedPrompt()`, then
   observes one browser response until completion. The adapter's broker result
   path completes the pending MCP invocation and resumes that same browser turn.
   No verified operation in this flow safely ends an in-progress browser turn,
   opens a following turn automatically, and retains its unfinished task and tool
   ledger. Aborting the worker is a cancellation, not proof of safe continuation.
   **Automatic boundary forcing has not been proven and is not implemented.**

2. **Attach during generation:** `ChatGptBrowserWorker.attachFiles()` is used in
   the `file_attachment` stage before the browser's `send` stage. There is no
   observed successful upload and follow-up send during an actively generating
   assistant response. This investigation did not write to or restart the live
   Feno Bridge installation or interact with its active ChatGPT tab. **Acceptance
   of a mid-generation attachment is unproven; this approach is not implemented.**

3. **Explicit delivery status:** Implemented. Every broker result with an image
   retains the original image content and appends a separate text part explicitly
   telling the model that it has not visually inspected the image in the current
   turn. A session-level count produces a user-visible final notice, even if the
   browser model omits the warning from its answer. Text-only results are not
   changed. For strict structured-output requests, the model receives the broker
   notice but the final plain-text suffix is suppressed to preserve the output
   format contract.

The implemented change prevents silent omission. It **does not fix visual delivery
inside the active turn**. A subsequent retained browser turn can use the existing
attachment path when the image remains in the immediate preceding round, subject
to the existing ten-image limit and conversation-retention conditions. End-to-end
automatic image delivery still requires a separately measured boundary or
in-generation upload mechanism.

## Verification

The image-only broker integration test asserts the original MIME image content,
the appended model-facing notice, and the user-visible final notice. A text-only
control checks that no image warning is added. The existing window-recovery
scenario checks that image recognition continues to work. The image-only test
passed, then failed when the model-facing note was deliberately removed
(`Expected length: 2; Received length: 1`), then passed again after restoration.
