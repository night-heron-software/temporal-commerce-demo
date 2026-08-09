/**
 * Authoring primitives shared by the decider-native surface (`defineMachine`).
 *
 * Historical note: this module once held the first-generation authoring surface —
 * `defineTransitions` (co-located prepare/decide/finalize phases), `route`, and the
 * `defineDomain` factory. That surface was retired in clarity-plan Phase 4 (ADR-0024)
 * once every domain had migrated to `defineMachine`; what remains here is the
 * vocabulary both generations shared.
 */

// ── Typed terminals ────────────────────────────────────────────────────

/** A terminal state name, branded by its reason. */
export type Terminal<R extends string> = `__terminal:${R}`;

/**
 * Build a terminal state name without the stringly-typed `__terminal:` prefix.
 * Constrain the reason to catch typos at compile time:
 *   terminal<'cancelled' | 'complete'>('cancelled')  // ok
 *   terminal<'cancelled' | 'complete'>('canceled')   // compile error
 */
export function terminal<R extends string>(reason: R): Terminal<R> {
  return `__terminal:${reason}`;
}

/**
 * Test the read side of a terminal without hardcoding the `__terminal:` prefix —
 * the companion to `terminal()`. `isTerminal(state)` is true for any terminal;
 * `isTerminal(state, 'complete')` is true only for that specific terminal. Use this in
 * `onTerminal`/`onCancellation` hooks instead of `state === '__terminal:complete'`.
 */
export function isTerminal(state: string, reason?: string): boolean {
  return reason === undefined ? state.startsWith('__terminal:') : state === `__terminal:${reason}`;
}

// ── Input metadata ─────────────────────────────────────────────────────

/**
 * Metadata about the driver input, passed into `enrich`. Exposes the deterministic
 * `input.timestamp` so commands are stamped from it rather than `Date.now()`.
 */
export interface InputMeta {
  /** ISO-8601 timestamp of the input, supplied deterministically by the driver. */
  timestamp: string;
}
