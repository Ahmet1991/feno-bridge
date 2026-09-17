const fs = require("node:fs");

function writeReadyMarker(filePath, version, at = Date.now(), startup = null) {
  fs.writeFileSync(filePath, `${JSON.stringify({
    version,
    at,
    ...(startup ? { startup } : {}),
  })}\n`, { mode: 0o600 });
}

async function waitForReadyMarker(filePath, version, notBefore, { timeoutMs = 5 * 60_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const marker = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (marker.version === version && Number.isFinite(marker.at) && marker.at >= notBefore) {
        return { version: marker.version, at: marker.at };
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Feno Bridge v${version} did not open within ${Math.ceil(timeoutMs / 1000)} seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function waitForFunctionalReadyMarker(
  filePath,
  version,
  notBefore,
  { timeoutMs = 5 * 60_000, pollMs = 250 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const marker = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const startup = marker?.startup;
      const freshWindow = marker.version === version && Number.isFinite(marker.at) && marker.at >= notBefore;
      const freshStartup = startup && Number.isFinite(startup.at) && startup.at >= notBefore;
      if (freshWindow && freshStartup) {
        if (startup.status === "repair-required") {
          const detail = typeof startup.detail === "string" && startup.detail.trim()
            ? `: ${startup.detail.trim()}`
            : "";
          throw new Error(`Feno Bridge v${version} requires repair${detail}`);
        }
        if (startup.status === "ready" || startup.status === "sign-in-required" || startup.status === "setup-required") {
          return {
            version: marker.version,
            at: marker.at,
            startup: {
              status: startup.status,
              at: startup.at,
              ...(typeof startup.detail === "string" && startup.detail ? { detail: startup.detail } : {}),
            },
          };
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Feno Bridge v${version} did not become functionally ready within ${Math.ceil(timeoutMs / 1000)} seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

module.exports = { writeReadyMarker, waitForFunctionalReadyMarker, waitForReadyMarker };
