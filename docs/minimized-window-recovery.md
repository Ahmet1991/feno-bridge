# Minimized-window recovery

## The failure

`@oai/sky` does not capture a minimized window and instead returns the sentence

```
window is minimized; call activate_window, refresh with get_window, then retry get_window_state
```

That sentence tells the model what to do next. Often the model reads it as a refusal, writes a final
answer saying the call was blocked, and the requested screenshot is never taken.

Measured from the rollout records in `~/.codex/sessions` and `~/.codex/archived_sessions`, counting
only results of a real `js` call and discarding occurrences that were quoted inside a file the model
was reading:

| session | live occurrences | image afterwards |
| --- | --- | --- |
| 2026-09-16 13:17 | 1 | yes |
| 2026-09-17 01:21 | 2 | no |
| 2026-09-19 21:20 | 2 | no |
| 2026-09-20 01:05 | 1 | yes |

Six live occurrences across four sessions; two of the four ended without ever producing the image.

## Why this is not an error

The call succeeds. `sky.get_window_state` returns the sentence as ordinary output, so the result
arrives as:

```json
[{"type": "input_text", "text": "Wall time: 0.0881 seconds\nOutput:"},
 {"type": "input_text", "text": "window is minimized; call activate_window, refresh with get_window, then retry get_window_state"}]
```

with `isError: false`. Nothing threw. A trigger keyed on the error flag would never fire, and the
turn's failed-call count must not be inflated to make one: v5.0.21's evidence line reports what the
bridge dispatched, and moving that number to drive a behaviour would make it lie.

So the trigger is not "a failed call". It is "a result that needs recovery".

## Trigger

All of the following must hold for the result of a single tool call:

1. The originating call used the `js` tool (including a namespaced `__js` wire name) and asked for
   a window observation — its arguments mention `get_window_state`. Either condition alone is not
   enough: `js` runs anything, while a shell or file-read command can quote `get_window_state`.
2. The result text, once the `Wall time: …` / `Output:` preamble is stripped, **is** the guidance
   sentence rather than merely containing it. This is what separates a live result from a quotation:
   live results are ~200 characters, while the occurrences found inside documents the model was
   reading ran 11,000–39,000 characters.
3. No direct Computer Use policy stop from another window-observation call is present elsewhere in
   the same result batch or earlier in the turn (see below).
4. The bridge has not already recovered once in this turn.

Text whose origin cannot be established does not trigger anything.

## Policy stops win

```
Computer Use has been stopped for this turn because it could not determine the current browser URL
on Windows with enough confidence to enforce policy. Stop your work and send a final message noting
why Computer Use ended.
```

This is the tool itself ending the turn. Before forwarding a parallel result batch, the bridge checks
the whole batch for this exact result from a window-observation call. A quotation in a file, page, or
unrelated tool result does not count. When the stop appears, any pending recovery is dropped,
recovery remains disabled for the rest of the turn, and the bridge neither sends a correction nor
suggests another route. Recovery exists to stop the model from mistaking guidance for a refusal, not
to push past a real one.

## Action

The bridge appends one labelled text part to the tool result on its way back to the model. The
original output is left byte-for-byte intact, `isError` is untouched, `structuredContent` is still
derived from the original text only, and the call ledger does not move.

At most one recovery per turn. A completed operation is never reopened, and nothing retries in a
loop: if the model ignores the note, the turn ends as it would have.

The correction rides on the result rather than being sent after the answer because the bridge has no
way to inject a message into a ChatGPT conversation mid-turn — `session.browserOutcome` resolves
once per round. Reaching the model at the moment of the result is also the point where it is most
likely to be acted on, rather than as one more rule inside a long preamble.

## Success

Success is not "an image appeared". It is an image returned by observing the window the recovery was
about. The bridge remembers the target parsed from the triggering call and only records success when
a later result in the same turn carries an image and its call names that same target.

Some calls select their window through a variable (`sky.get_window_state({window: windows[0]})`), so
no target can be parsed. Recovery still fires — the note is correct without naming a window — but
the recovery is logged as unbound and later success is not claimed.

## Guarding against a silent pass

The guidance sentence is produced by the `@oai/sky` runtime, not by any file in the installed plugin,
so it cannot be version-checked statically. The recorded occurrences come from computer-use
`26.911.61220`; `26.915.31945` is installed at the time of writing. A test frozen on the old wording
would stay green while the real path quietly stopped matching.

The bridge therefore logs a near miss: a window-observation call that returns a short result with no
image and no recognised sentence. The warning carries only the result length and a short SHA-256
fingerprint, not the window text itself. If the wording changes, the log shows a new stable signature
instead of saying nothing. The 2,000-character threshold is based on the recorded sample; it is a
diagnostic warning, not a guarantee that every future short result is new guidance.

## Out of scope

- Ending a turn without ever making a call. The bridge has no intent information to detect it.
- `window.app must be a non-empty string and window.id must be an integer >= 0`, the malformed
  argument result. It is a different failure and is left alone.
