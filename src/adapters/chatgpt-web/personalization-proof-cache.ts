// A stale proof costs nothing extra: connector selection finds the connector row missing, drops
// the proof and proves again in the same turn. So the TTL only bounds how long a proof is trusted.
export const CHATGPT_PERSONALIZATION_PROOF_TTL_MS = 60 * 60_000;

type ProofKey = object | string;
interface Proof { session: string; expiresAt: number }

/**
 * A proof belongs to one browser surface and one authenticated session, never to a worker
 * globally. The surface is a live Page, or the launcher's stable surface id: every launcher turn
 * opens a fresh CDP connection and so a fresh Page object, and a Page-keyed proof never outlived
 * its turn (28.09: 28 of 36 resumed turns proved again, ~2.7 s each, 30 s after the last proof).
 */
export class ChatGptPersonalizationProofCache {
  private readonly pageProofs = new WeakMap<object, Proof>();
  private readonly surfaceProofs = new Map<string, Proof>();

  isValid(key: ProofKey, session: string | undefined, now = Date.now()): boolean {
    const proof = this.get(key);
    if (!session || !proof || proof.session !== session || now >= proof.expiresAt) {
      this.invalidate(key);
      return false;
    }
    return true;
  }

  remember(key: ProofKey, session: string | undefined, now = Date.now()): void {
    if (!session) return;
    const proof = { session, expiresAt: now + CHATGPT_PERSONALIZATION_PROOF_TTL_MS };
    if (typeof key === "string") this.surfaceProofs.set(key, proof);
    else this.pageProofs.set(key, proof);
  }

  invalidate(key: ProofKey): void {
    if (typeof key === "string") this.surfaceProofs.delete(key);
    else this.pageProofs.delete(key);
  }

  private get(key: ProofKey): Proof | undefined {
    return typeof key === "string" ? this.surfaceProofs.get(key) : this.pageProofs.get(key);
  }
}
