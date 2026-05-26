import { UpdateDefinition, Duration, SignalDefinition } from '@temporalio/common';

export type StateInput<TEvent, TSignal = never> =
  | { kind: 'event'; event: TEvent }
  | { kind: 'signal'; result: TSignal }
  | { kind: 'timeout' };

export interface StateOutput<TState extends string, TContext, TResponse> {
  context: TContext;
  next: TState | `__terminal:${string}`;
  response?: TResponse;
  error?: string;
}

export type StateFunction<TState extends string, TEvent, TContext, TResponse, TSignal = never> = (
  ctx: Readonly<TContext>,
  input: StateInput<TEvent, TSignal>,
) => Promise<StateOutput<TState, TContext, TResponse>>;

export interface StateConfig<TState extends string, TEvent, TContext, TResponse, TSignal = never> {
  fn: StateFunction<TState, TEvent, TContext, TResponse, TSignal>;
  timeout: Duration;
}

export type StateRegistry<TState extends string, TEvent, TContext, TResponse, TSignal = never> = Record<
  TState,
  StateConfig<TState, TEvent, TContext, TResponse, TSignal>
>;

export interface UpdateExchange<TEvent, TResponse> {
  event: TEvent;
  result?: TResponse;
  error?: string;
  processed: boolean;
}

export interface StateMachineConfig<TState extends string, TEvent, TContext, TResponse, TSignal = never> {
  states: StateRegistry<TState, TEvent, TContext, TResponse, TSignal>;
  initialState: TState;
  continueAsNewThreshold?: number;
  serializeForContinueAsNew?: (ctx: TContext, currentState: TState) => unknown;
  onTerminal?: (ctx: TContext, terminalState: string) => Promise<void>;
  onCancellation?: (ctx: TContext, currentState: TState | `__terminal:${string}`) => Promise<void>;
  onContextUpdate?: (ctx: TContext, currentState: TState | `__terminal:${string}`) => void;
  onStart?: (ctx: TContext) => Promise<{ context: TContext; nextState?: TState | `__terminal:${string}` }>;
  onTransition?: (
    from: TState,
    to: TState | `__terminal:${string}`,
    event: TEvent | 'timeout' | 'signal',
    ctx: TContext
  ) => Promise<void> | void;
}

export interface MappedUpdateRegistration<
  TEvent,
  TContext,
  TResponse,
  TArgs extends any[] = any[],
> {
  definition: UpdateDefinition<TResponse, TArgs>;
  toEvent: (...args: TArgs) => TEvent;
  formatError?: (error: string, ctx: TContext) => TResponse;
  formatResponse?: (response: TResponse, ctx: TContext) => TResponse;
}

export type SingleUpdateRegistration<TEvent, TResponse> = UpdateDefinition<TResponse, [TEvent]>;

export interface SignalRegistration<TSignal, TArgs extends any[] = any[]> {
  definition: SignalDefinition<TArgs>;
  toSignal: (...args: TArgs) => TSignal;
}

/** Extract the terminal reason from '__terminal:reason' strings */
export type TerminalSuffix<T extends string> = T extends `__terminal:${infer R}` ? R : never;
