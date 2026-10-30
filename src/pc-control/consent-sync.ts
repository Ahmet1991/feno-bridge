import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PcAuthorizer, validatePcGrant } from "./authorization";
import type { PcGrant } from "./types";

export const PC_HEARTBEAT_MAX_AGE_MS = 15_000;

/** Reads the signed, local Feno launcher lease. No model input can set these paths. */
export function createPcPolicySync(options: {
  directory: string;
  authorizer: PcAuthorizer;
  clock?: () => number;
  onRevoked?: () => void;
}) {
  const clock = options.clock ?? Date.now;
  let lastGrantId: string | undefined;

  const revoke = () => {
    if (lastGrantId || options.authorizer.status().enabled) options.onRevoked?.();
    lastGrantId = undefined;
    options.authorizer.revoke();
  };

  return {
    refresh() {
      try {
        const keyString = readFileSync(join(options.directory, "pc-consent-key"), "utf8");
        if (!/^[a-f0-9]{64}$/.test(keyString)) throw new Error("invalid local key");
        const raw = readFileSync(join(options.directory, "pc-consent-state.json"), "utf8");
        if (Buffer.byteLength(raw) > 32_768) throw new Error("oversized local consent state");
        const envelope: unknown = JSON.parse(raw);
        if (!envelope || typeof envelope !== "object") throw new Error("invalid envelope");
        const { payload, signature } = envelope as { payload?: unknown; signature?: unknown };
        if (!payload || typeof payload !== "object" || typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) {
          throw new Error("invalid signature format");
        }
        const expected = createHmac("sha256", Buffer.from(keyString, "hex"))
          .update(JSON.stringify(payload)).digest();
        if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new Error("invalid signature");
        const { schema, heartbeatAt, grant } = payload as { schema?: unknown; heartbeatAt?: unknown; grant?: unknown };
        const now = clock();
        if (schema !== 1 || !Number.isSafeInteger(heartbeatAt) || typeof heartbeatAt !== "number"
          || heartbeatAt > now + 2_000 || now - heartbeatAt > PC_HEARTBEAT_MAX_AGE_MS) {
          throw new Error("stale local approval");
        }
        if (grant === null) { revoke(); return; }
        validatePcGrant(grant as PcGrant, now);
        const candidate = grant as PcGrant;
        if (lastGrantId !== candidate.id) {
          // A fresh local scope must not inherit jobs started under the previous grant.
          if (lastGrantId) {
            options.onRevoked?.();
            options.authorizer.revoke();
          }
          options.authorizer.setGrantFromLocalApproval(candidate);
          lastGrantId = candidate.id;
        }
      } catch {
        revoke();
      }
    },
  };
}
