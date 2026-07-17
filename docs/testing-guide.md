# Testing Without Mocking

> **Status:** stub — outline in place, sections to be expanded. The topics below are partially
> covered today in the [Developer Guide](developer-guide.md) (see links per section).

This project's test suite runs **230 tests across 29 files in about six seconds, with zero
containers and zero mocks**. Nothing in the pyramid stubs the system under test: pure decision
functions are tested directly, workflow tests execute the real workflow code on Temporal's
time-skipping test server, and end-to-end tests drive the real local stack. This guide explains how
the architecture makes that possible and how to write tests at each level.

## Outline

1. **The three-level pyramid** — what each level covers, what it costs, when to add a test where.
2. **Level 1: pure decider tests** — `expect(decide(command, state)).toEqual(facts)` with no
   harness; why the prepare → decide → finalize split makes decisions testable without I/O.
   *(Today: [Developer Guide § Declarative State Machine Pattern](developer-guide.md#declarative-state-machine-pattern-runstatemachine).)*
3. **Level 2: workflow tests on the time-skipping test server** — running the real
   `runStateMachine` driver against `@temporalio/testing`; fast-forwarding a 30-day cart timeout in
   milliseconds; asserting on state transitions rather than implementation details.
4. **Level 3: end-to-end order journeys** — `src/temporal/order-journey.e2e.test.ts` against the
   real local containers; when e2e is worth its runtime.
5. **Structural tests over the state graph** — `src/temporal/state-graph.test.ts`: no orphan
   states, no dangling `next` targets, every terminal reachable.
6. **Why no mocks** — the trade being made: purity at the core instead of test doubles at the
   edges; what you give up and what you get back.
7. **Running and extending the suite** — `npm test`, `npm run test:watch`, `npm run coverage`;
   conventions for co-locating `*.test.ts` files.
