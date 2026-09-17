# Windows Computer Use

Use this route when the user asks to inspect or control the Windows desktop, File Explorer, or another native Windows application.

1. Read the `computer-use:computer-use` skill supplied in the current session before deciding native Computer Use is unavailable. Read the guidance, API, and confirmation documents that skill requires for the operation. Plugin versions and install paths can differ between machines, so do not hard-code a user-specific plugin path here.
2. If `node_repl` is deferred, discover it with the session's tool discovery mechanism. When `tool_search` is available, search for `node_repl`. Verify the actual tool name and availability from the returned tool list; do not invent unavailable tool calls.
3. In a fresh `node_repl` JavaScript session, initialize the native Windows API with:

   ```js
   if (!globalThis.sky) {
     const { sky } = await import("@oai/sky");
     globalThis.sky = sky;
   }
   ```

4. Verify native access from that same session before acting:

   ```js
   globalThis.windows = await sky.list_windows();
   nodeRepl.write(JSON.stringify(globalThis.windows, null, 2));
   ```

   `sky.list_apps()` is also valid when application discovery is more useful.
5. Select a window object that was actually returned by the current `list_windows()` / `list_apps()` result. If several candidates exist, use current title and app information to identify one target. Never reuse a guessed window id, fixed list index, or accessibility index from an earlier session.
6. Use an observe/action/verify loop: read the target window state, inspect the current screenshot or accessibility tree, act from that current observation, then read state again to verify the result. If a window should have closed, refresh the window list when that is the clearest verification.

An empty application list or `Native computer APIs are disabled` result from the `mcp__cua_repl` surface does not prove that the `node_repl` + `@oai/sky` route is unavailable. Do not tell the user that local Windows access is unavailable until the native route above has actually been checked.

If `node_repl` cannot be found, `@oai/sky` cannot be imported, or a native call fails, report the specific missing or failed component. Do not assume another machine has the same installation. Honor real permission denials, a locked desktop, user cancellation, and required confirmations; do not route around them with another tool.

Use browser automation tools for browser tasks and this native route for local Windows applications. Existing user authorization in the same conversation remains valid unless the requested scope or risk changes or a real confirmation requirement applies. Do not infer a separate consequential choice such as discarding unsaved data from a simple request to close a window.

Base completion reports on actual tool results. Do not claim a security layer blocked an action without a real refusal/error result, and do not report an attempted action as completed until its result has been verified.
