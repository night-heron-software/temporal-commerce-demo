/**
 * Shared Temporal activity that marks ES projection docs completed at workflow close.
 *
 * Spread `projectionCompletionActivities` into every domain worker's `activities` bundle so
 * the framework driver can proxy `markProjectionsCompleted` by name on that task queue
 * (same convention as `transitionRecorderActivities`, ADR-0010).
 */
import { markProjectionsCompleted } from './repository';

export const projectionCompletionActivities = { markProjectionsCompleted };

export type ProjectionCompletionActivities = typeof projectionCompletionActivities;
