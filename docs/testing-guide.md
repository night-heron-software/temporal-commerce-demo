# Testing Without Containers

This project's test suite runs **514 tests across 63 files in about six seconds, with zero
containers** — it passes with the Docker daemon not running at all. That is the claim worth making,
and it is the one that changes how the project is developed: every contributor and every CI run
exercises the whole system on every change, rather than the subset someone bothered to start
infrastructure for.

**What about mocks?** The suite is not mock-free, and it would be dishonest to say so. Twenty-six
of the sixty-three test files use no test doubles of any kind — including every decider test, which
is where the business logic lives. The other thirty-seven stub at the **I/O boundary**: activities
and the infrastructure clients behind them are where this architecture puts its I/O, so replacing
them in a workflow or route test supplies the boundary rather than faking the thing under test. The
trade being made is purity at the core, not the absence of test doubles everywhere.

## The three-level pyramid

| Level                   | What runs                                               | What's doubled                        | Speed       |
| ----------------------- | ------------------------------------------------------- | ------------------------------------- | ----------- |
| 1. Decider tests        | `decide` / `evolve` as plain functions                  | Nothing                               | µs per case |
| 2. Workflow tests       | Real driver + states on the time-skipping test server   | I/O activities                        | ~100s of ms |
| 3. Cross-domain journey | Four domains orchestrating each other, same test server | I/O activities (with one live bridge) | seconds     |

Plus a structural level that isn't on the pyramid: generated-artifact tests over the state graph.

The policy (see [AGENTS.md](../AGENTS.md), invariant 4): **changes to decider / states files
require co-located `*.test.ts` tests.** Most of what matters about the system is testable at
level 1, which is why most of the suite needs nothing installed.

## Level 1 — pure decider tests

Every domain's decision logic is a pure Chassaing decider
([ADR-0009](adr/0009-chassaing-decider-transfer-pilot.md)): `decide(command, state) → facts`,
`evolve(state, fact) → state`, no clock, no randomness, no I/O. Testing it needs no harness at
all — [cart-decider.test.ts](../src/temporal/cart/cart-decider.test.ts) is the pattern:

```ts
// build states with plain object builders, fold commands with the real functions
const apply = (ctx: CartWorkflowContext, cmd: CartCommand): CartWorkflowContext =>
  decide(cmd, ctx).reduce(evolve, ctx);

expect(decide(command, state)).toEqual(expectedFacts);
```

Two conventions worth copying:

- **Builders over fixtures.** `makeCart(overrides)` / `makeCtx(overrides)` construct valid states
  with targeted deviations — each test names only what it cares about.
- **Fold, then assert.** For multi-step scenarios, `decide(...).reduce(evolve, ctx)` replays a
  command sequence exactly the way the shell does, so the test exercises the same path production
  takes.

Time is data here: commands carry `meta.timestamp`, so "what happens after the timeout" is a test
input, not a `vi.useFakeTimers()` dance.

## Level 2 — workflow tests on the time-skipping test server

The real workflow code — the actual `runStateMachine` driver, the actual states registry — runs
against Temporal's `TestWorkflowEnvironment`, which fast-forwards timers: a 30-day cart timeout
executes in milliseconds. The shared harness is
[test-support/workflow-env.ts](../src/test-support/workflow-env.ts) (`withWorkflowEnv`), and
[cart-workflow.test.ts](../src/temporal/cart/cart-workflow.test.ts) is the pattern:

```ts
const cartWorker = { taskQueue: CART_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities };

await withWorkflowEnv([cartWorker], async (env) => {
  const handle = await env.client.workflow.start(cartWorkflow, startOpts('cart-1'));
  const res = await handle.executeUpdate(cartUpdate, {
    args: [{ type: 'addItem', variantId: 'v1', quantity: 2, price: 22.99 }],
  });
  expect((await handle.query(getCartQuery)).items).toHaveLength(1);
});
```

**Activities are stubbed here, deliberately.** The activity map passed to the worker replaces I/O
(`validateInventory: async () => true`, `indexCart: async () => undefined`, …) so these tests
assert _orchestration_ — update handlers, queries, state transitions, terminal behavior, activity
wiring — not persistence. The decider level already proved the decisions; this level proves the
machine around them.

What belongs at this level: update/signal/query handler behavior, timeout paths (the test server
makes them cheap), `continueAsNew` behavior, cross-state routing. What doesn't: decision logic
(level 1 owns it) and real database writes (nothing owns them in this suite — that's the honest
boundary of a container-free suite; `npm run test:e2e`-style live verification happens against a
running stack via the scripts in [`.agent/workflows/`](../.agent/workflows/)).

## Level 3 — the cross-domain journey

[order-journey.e2e.test.ts](../src/temporal/order-journey.e2e.test.ts) drives
**cart → checkout → OMS → fulfillment** on the same time-skipping server: four domains, real
`startChild`/signal orchestration, one test.

Its most instructive detail is the `queryCart` activity, which is barely a stub — it queries the
_live_ cart workflow through the test environment's client, exactly as the production activity
does through its own Temporal client:

```ts
queryCart: vi.fn(async (parentCartWorkflowId: string) => {
  const cart = await envRef.env!.client.workflow
    .getHandle(parentCartWorkflowId)
    .query(getCartQuery);
  return { items: cart.items, /* … */ };
}),
```

So the cross-workflow seam — checkout reading the live cart — is exercised for real; only the
Cassandra/Elasticsearch edges are canned.

## Structural tests over the state graph

[state-graph.test.ts](../src/temporal/state-graph.test.ts) asserts properties of the **generated**
`state-graph.json` for every machine: every non-transitional state has an outgoing transition (no
dead ends), every state is reachable from the initial state, every machine's initial state exists.
Combined with the CI freshness gate (`npm run docs:diagrams:check`), this means an agent or human
who adds an orphan state gets a failing build, not a quiet inconsistency — see
[ADR-0003](adr/0003-prepare-decide-evolve-state-machines.md) for why the graph is generated at
all.

## Where the seams are

The layering falls out of the architecture rather than testing discipline:

- **Decider** — no seam needed; it's pure by construction (lint-enforced).
- **Workflow ↔ activity** — the one true seam. Activities are the I/O membrane, so a stubbed
  activity map is the honest double.
- **Workflow ↔ workflow** — _not_ stubbed. Child workflows and signals run for real on the test
  server at levels 2–3.
- **Route handlers** (`src/app/api/**/*.test.ts`) — standard vitest with `vi.mock` for the ES/
  Cassandra clients; conventional Next.js testing, not part of the Temporal pyramid.

## Running and extending the suite

```bash
npm test              # full suite, ~7s, no Docker
npm run test:watch    # vitest watch mode
npm run coverage      # v8 coverage
```

- Tests are **co-located**: `foo.ts` → `foo.test.ts` in the same directory.
- Changing a decider or states file? The co-located test is **required** — and run
  `npm run docs:diagrams` afterward; CI fails stale diagrams.
- Adding a domain? The [Extending the Demo](developer-guide.md#extending-the-demo) recipe names
  which tests each step owes.
