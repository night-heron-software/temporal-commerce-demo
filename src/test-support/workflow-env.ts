/**
 * Temporal workflow test harness (ported from nightheron-mono's @nightheron/test-support).
 *
 * Test-only helpers for driving real workflows through the `runStateMachine` driver in a
 * time-skipping `TestWorkflowEnvironment`. Register one worker per domain task queue (so cross-domain
 * `startChild` / `getExternalWorkflowHandle` orchestration resolves), mock the I/O activities, and
 * assert on updates / queries / signals / results.
 *
 * Consumed only from `*.test.ts`; never imported by production or workflow-sandbox code.
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

// The custom correlation Search Attributes (SEARCH_ATTRIBUTE_KEYS in
// src/temporal/contracts/constants.ts). Every domain workflow start sets these via
// buildWorkflowStartOptions, so the test server must know them or the start is
// rejected. Kept as literals here to avoid a contracts dependency in test-support.
const CORRELATION_SEARCH_ATTRIBUTES = ['CorrelationId', 'StoreId', 'Domain', 'OrderId', 'CartId'];
// temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD — inlined to
// avoid an @temporalio/proto dependency just for one enum constant.
const INDEXED_VALUE_TYPE_KEYWORD = 2;

/**
 * Register the correlation Search Attributes on the test server's `default` namespace.
 * Idempotent / best-effort: a server that already has them (or doesn't support the
 * operator RPC) is fine — any genuine problem surfaces when a workflow start is rejected.
 */
async function registerCorrelationSearchAttributes(env: TestWorkflowEnvironment): Promise<void> {
  const searchAttributes: Record<string, number> = {};
  for (const name of CORRELATION_SEARCH_ATTRIBUTES) {
    searchAttributes[name] = INDEXED_VALUE_TYPE_KEYWORD;
  }
  try {
    await env.connection.operatorService.addSearchAttributes({
      namespace: 'default',
      searchAttributes,
    });
  } catch {
    // Already registered or unsupported by this server build — ignore.
  }
}

/** A worker to stand up in the test env: one per domain task queue. */
export interface WorkerSpec {
  taskQueue: string;
  /** Absolute path to the domain's `workflows` entrypoint (compute from `import.meta.url` in the test). */
  workflowsPath: string;
  /** Mocked activity implementations (the real ones do Cassandra/ES/HTTP I/O). */
  activities?: Record<string, (...args: never[]) => unknown>;
}

/**
 * Create a time-skipping `TestWorkflowEnvironment`, stand up a worker per {@link WorkerSpec}, run `fn`
 * against the env, then drain the workers and tear the env down. Returns whatever `fn` resolves to.
 *
 * For a single domain pass one spec; for the cross-domain spine pass one per participating queue.
 */
export async function withWorkflowEnv<T>(
  specs: WorkerSpec[],
  fn: (env: TestWorkflowEnvironment) => Promise<T>,
): Promise<T> {
  if (specs.length === 0) throw new Error('withWorkflowEnv: at least one WorkerSpec is required');

  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    await registerCorrelationSearchAttributes(env);
    const workers = await Promise.all(
      specs.map((s) =>
        Worker.create({
          connection: env.nativeConnection,
          taskQueue: s.taskQueue,
          workflowsPath: s.workflowsPath,
          // Register a no-op transition-recorder activity (ADR-0010) on every test worker so
          // state-machine workflows — which activate the recorder because withWorkflowEnv tags
          // them with correlation Search Attributes — don't stall on an unregistered activity or
          // require a live Cassandra. Same for the projection-completion mark scheduled at
          // workflow close. A spec may override either.
          activities: {
            persistWorkflowTransitions: async () => {},
            markProjectionsCompleted: async () => {},
            ...s.activities,
          },
        }),
      ),
    );

    const runners = workers.map((w) => w.run());
    try {
      return await fn(env);
    } finally {
      workers.forEach((w) => w.shutdown());
      await Promise.allSettled(runners);
    }
  } finally {
    await env.teardown();
  }
}
