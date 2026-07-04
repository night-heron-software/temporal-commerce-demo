/**
 * Shared Temporal activity for the async state-transition projection (ADR-0010).
 *
 * Spread `transitionRecorderActivities` into every domain worker's `activities` bundle so the
 * framework's in-workflow recorder can proxy `persistWorkflowTransitions` by name on that task
 * queue.
 */
import { persistWorkflowTransitions } from './repository';

export const transitionRecorderActivities = { persistWorkflowTransitions };

export type TransitionRecorderActivities = typeof transitionRecorderActivities;
