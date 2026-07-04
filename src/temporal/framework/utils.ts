/**
 * Framework Utilities
 *
 * Shared helpers for state machine workflows.
 */

/**
 * Strip the `__terminal:` prefix from a state machine state name to produce
 * a display-friendly status string.
 *
 * Example:
 *   deriveDisplayStatus('__terminal:delivered') → 'delivered'
 *   deriveDisplayStatus('processing')           → 'processing'
 */
export function deriveDisplayStatus<T extends string>(state: string): T {
  return (state.startsWith('__terminal:') ? state.replace('__terminal:', '') : state) as T;
}
