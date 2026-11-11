# GitHub runner status

`pc_runner_status` can read the state of an explicitly configured GitHub Actions runner. Its existing local `runner` permission is still required.

Place `pc-runner.json` in the current Feno profile directory. For the isolated DEV profile this is `%USERPROFILE%\.codex-chatgpt-web-dev\pc-runner.json`:

```json
{
  "schema": 1,
  "repository": "Ahmet1991/AkentekIPTV",
  "runnerName": "fenotip-vestel-pc",
  "label": "fenotip-tv"
}
```

Restart the DEV runtime after first adding the file. Subsequent queries reread an existing configuration. The normal Feno profile remains independent.

The probe uses the installed GitHub CLI's current authentication. It sends only a fixed GET request to `github.com`; the MCP request cannot change the repository, executable or URL. It neither dispatches jobs nor starts/stops/reconfigures runners. Configuration must not contain a token. The operation times out after eight seconds and accepts at most 256 KiB of API output.

Both name and label must match. A successful response contains `state`, `source: "configured-probe"`, `runnerName`, and the API's `busy` flag. It does not invent an active job name.

Missing configuration returns `unknown / not-configured`. Invalid configuration, unavailable CLI/login, denied API access, network failure or malformed data returns `unknown / probe-error`. Missing or ambiguous matching runners remain `unknown`, not `offline`. A query reads at most the first 100 runners; a match outside that page cannot be confirmed. No credential or raw API error is returned through MCP.
