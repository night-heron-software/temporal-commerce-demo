export * from './types';
export * from './driver';
export { createTransitionRecorder } from './transition-sink';
export { conventionIdentityResolver, workflowCorrelationId } from './identity';
export type { ConventionIdentityOptions } from './identity';
export { transitionActivityInterceptors } from './activity-capture';
export { deriveDisplayStatus } from './utils';
export { terminal, isTerminal } from './authoring';
export type { Terminal, InputMeta } from './authoring';
// The decider-native surface (ADR-0024) — the standard for machine domains.
export { defineMachine, applyCommand, reject, isRejection } from './machine';
export type {
  MachineDecider,
  MachineConfig,
  MachineState,
  CommandHandler,
  EffectsMap,
  EventRoute,
  Rejection,
} from './machine';
// The CommandBlock authoring surface (ADR-0024) and its two assemblers (ADR-0026).
export { deriveRoutes, assembleEvolve } from './command-block';
export type { CommandBlock, RouteMap, RouteTarget, EvolveMap } from './command-block';
