# Feno Bridge 5.1.33

The own-profile Chrome extension no longer rejects input, form changes, keyboard
events, or JavaScript diagnostics merely because a page contains password or
payment fields. These operations still require the existing locally enabled
Chrome access and full-access grant. Sensitive form values are returned as
`[REDACTED]` rather than echoed in tool results.

Readonly fields, stale references, screenshot geometry, frame boundaries,
restricted URLs, native-host identity, and secret masking in network diagnostics
retain their existing checks. Agent and host confirmation policies remain separate
from the extension's field-type checks.

The release runner now updates the Chrome manifest together with the runtime and
launcher versions, so the normal release verification accepts a new patch version.
Screenshot and diagnostic widget URIs now derive from the shared runtime version;
cached older URIs retain their tested aliases after an update. Windows Bun-run
test fixtures use their current executable without requiring a PATH entry.

Validation is recorded by the release runner and the exact-tag Release workflow.
Local regression tests cover real DOM password/payment/label inputs and redaction,
engine typing/keyboard/JS paths, retained frame checks, and version bump behavior.
Authenticated account flows and real payments are not exercised by these tests.
