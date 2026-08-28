/**
 * Declaration checks that run before a machine takes its first step — the pure half.
 *
 * ## Why a machine is checked all at once, up front
 *
 * A driver that validates lazily fails when the offending state is *reached*, which on a long
 * machine can be many steps and much production traffic later. Checking the whole registry before
 * the loop starts makes the failure deterministic and immediate: the machine either is well-formed
 * or it does not run.
 */

/**
 * States that wait for input without saying how long — `mono-backlog-069`.
 *
 * The driver used to resolve a waiting state's timer as `(…) ?? '1 millisecond'`, so a
 * non-transitional state that omitted `timeout` woke **a thousand times a second**. Every wake is a
 * workflow task with its history events, all counted toward continue-as-new, and it produced **no
 * error and no log line** — the machine simply ran hot, which reads as a load problem rather than a
 * declaration mistake.
 *
 * The default is not merely too fast; it is wrong to have one. **Nothing ever relied on it** — an
 * omitted `timeout` on a waiting state has only ever been a mistake — so the honest behaviour is to
 * refuse the declaration rather than to pick a different number and keep spinning.
 *
 * `transitional` states are exempt by construction: they never wait, so a timer would be
 * meaningless for them.
 */
export function findWaitingStatesWithoutTimeout(
  states: Record<string, { timeout?: unknown; transitional?: boolean }>,
): string[] {
  return Object.entries(states)
    .filter(([, cfg]) => !cfg.transitional && cfg.timeout === undefined)
    .map(([name]) => name)
    .sort();
}

/** The message a malformed machine fails with. Names the states, so the fix is obvious. */
export function describeMissingTimeouts(machineName: string, offenders: string[]): string {
  return (
    `State machine "${machineName}" declares ${offenders.length} waiting state(s) with no ` +
    `timeout: ${offenders.join(', ')}. A non-transitional state must say how long it waits — ` +
    `without one the driver would poll continuously, burning workflow tasks toward ` +
    `continue-as-new with no error and no log line. Add an explicit timeout, or mark the state ` +
    `transitional if it is not meant to wait at all.`
  );
}

/**
 * Should the driver continue-as-new now — `mono-backlog-068`.
 *
 * The driver continued on a **fixed input count**. Temporal names that pitfall in as many words:
 * *"Using a fixed iteration count instead of the built-in suggestion. Different Workflow paths
 * generate different numbers of events per iteration. A fixed count may continue too early or too
 * late."* The count is over *inputs*, and an input's event cost varies with the path it takes, so no
 * single number is right for every machine.
 *
 * The SDK's own `continueAsNewSuggested` measures the thing that actually matters — history size —
 * so it leads. An explicit `threshold` still applies as a **ceiling** rather than the primary
 * signal: a machine that knows something the SDK does not can still cap itself, but it can no
 * longer continue *later* than the SDK thinks wise.
 */
export function shouldContinueAsNew(input: {
  /** `workflowInfo().continueAsNewSuggested` — the SDK's view of history pressure. */
  suggested: boolean;
  /** Inputs processed in this run. */
  inputCount: number;
  /** Optional explicit ceiling. `undefined` means "trust the SDK alone". */
  threshold?: number;
}): boolean {
  if (input.suggested) return true;
  return input.threshold !== undefined && input.inputCount >= input.threshold;
}
