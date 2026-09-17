const fs = require("node:fs");

function writeReadyMarker(filePath, version, at = Date.now()) {
  fs.writeFileSync(filePath, `${JSON.stringify({ version, at })}\n`, { mode: 0o600 });
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

module.exports = { writeReadyMarker, waitForReadyMarker };
