export const CHATGPT_PERSONALIZATION_PROOF_TTL_MS = 15 * 60_000;

/** A proof belongs to one live Page and one authenticated session, never to a worker globally. */
export class ChatGptPersonalizationProofCache {
  private readonly proofs = new WeakMap<object, { session: string; expiresAt: number }>();

  isValid(page: object, session: string | undefined, now = Date.now()): boolean {
    const proof = this.proofs.get(page);
    if (!session || !proof || proof.session !== session || now >= proof.expiresAt) {
      this.proofs.delete(page);
      return false;
    }
    return true;
  }

  remember(page: object, session: string | undefined, now = Date.now()): void {
    if (session) this.proofs.set(page, { session, expiresAt: now + CHATGPT_PERSONALIZATION_PROOF_TTL_MS });
  }

  invalidate(page: object): void {
    this.proofs.delete(page);
  }
}
