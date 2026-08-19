/**
 * Reading the outcome of a Temporal update honestly.
 *
 * Ported from nightheron-mono `75b30296` (#242). Extracted from `cart-actions.ts` for the same
 * reason: that file is `'use server'` and drags the Temporal client in with it, so the decisions
 * worth testing cannot be tested where they were written. These two functions are pure.
 *
 * ## The failure this guards against (mono validation run 013)
 *
 * The mono's storefront log reported success at every step of a triple charge — `ok: true` on
 * actions whose worker-side counterparts had failed, because the wrapper only distinguished
 * throw from no-throw. **False success is worse than silence** — silence invites a look,
 * `ok: true` closes the question. The demo's wrappers had the same blind spot: a transport-level
 * success carrying `{ error: 'CART_CHANGED' }` logged `ok: true`.
 */

/**
 * Dig the DOMAIN's own words out of a Temporal update rejection.
 *
 * A decider `reject('Order is being placed — please wait')` reaches the client as
 * `WorkflowUpdateFailedError: Workflow Update failed`, with the real sentence one or two `cause`
 * links down. A UI that matches on the outer message recognises nothing and blames the network
 * for a refusal the system made deliberately and explained — and a shopper who believes the
 * connection failed retries, which is how the mono's #235 produced a triple charge.
 *
 * Returns the innermost message that is not the generic transport one, or `undefined` when the
 * transport message is all there is — which is what a real connectivity failure looks like, and
 * must not be dressed up as a domain refusal.
 */
export function domainMessageOf(e: unknown): string | undefined {
  const GENERIC = /^workflow update failed/i;
  const seen = new Set<unknown>();
  let node: unknown = e;
  let best: string | undefined;
  // Bounded AND cycle-guarded: an error whose `cause` points at itself must not hang a request.
  for (let depth = 0; node && depth < 5 && !seen.has(node); depth += 1) {
    seen.add(node);
    const msg = (node as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim() && !GENERIC.test(msg)) best = msg;
    node = (node as { cause?: unknown }).cause;
  }
  return best;
}

/**
 * A domain failure that arrived as a VALUE rather than an exception.
 *
 * A Temporal update returning `{ error: 'CART_CHANGED' }` is, at the transport level, a success —
 * so a wrapper that only distinguishes throw from no-throw logs `ok: true` for it.
 *
 * Deliberately conservative: an empty `error` string is not a failure, and neither is a result
 * this cannot understand. Over-reporting would train readers to ignore the line, which is the
 * same end state as not logging it.
 */
export function domainErrorOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as {
    error?: unknown;
    step?: unknown;
    checkout?: { error?: unknown; step?: unknown };
  };
  if (typeof r.error === 'string' && r.error) return r.error;
  if (r.step === 'failed') return 'step=failed';
  if (typeof r.checkout?.error === 'string' && r.checkout.error) return r.checkout.error;
  if (r.checkout?.step === 'failed') return 'checkout.step=failed';
  return undefined;
}
