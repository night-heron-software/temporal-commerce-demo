/**
 * Workflow-interceptor entry module for Temporal (ADR-0010).
 *
 * Temporal registers workflow interceptors from modules listed in the worker's
 * `interceptors.workflowModules` — NOT from an `interceptors` export on the workflows entry file.
 * Point each state-machine worker at this module:
 *
 *   Worker.create({
 *     ...,
 *     interceptors: {
 *       workflowModules: [require.resolve('@nightheron/state-machine/interceptors')],
 *     },
 *   })
 *
 * It shares the `activity-capture` module instance with `definePureState` (same workflow bundle),
 * so prepare/finalize activity capture works.
 */
export { transitionActivityInterceptors as interceptors } from './activity-capture';
