# Testing Without Containers

> **Status:** stub — outline in place, sections to be expanded. There is no testing section in the
> [Developer Guide](developer-guide.md) yet, so this outline is currently the only testing-specific
> documentation; the test files themselves are the working reference.

This project's test suite runs **230 tests across 29 files in about seven seconds, with zero
containers** — it passes with the Docker daemon not running at all. That is the claim worth making,
and it is the one that changes how the project is developed: every contributor and every CI run
exercises the whole system on every change, rather than the subset someone bothered to start
infrastructure for.

**What about mocks?** The suite is not mock-free, and it would be dishonest to say so. Twelve of the
twenty-nine test files use no test doubles of any kind — including every decider test, which is
where the business logic lives. The other seventeen stub at the **activity boundary**: activities
are where this architecture puts its I/O, so replacing them in a workflow test supplies the
boundary rather than faking the thing under test. The trade being made is purity at the core, not
the absence of test doubles everywhere.

## Outline

1. **The three-level pyramid** — what each level covers, what it costs, when to add a test where.
2. **Level 1: pure decider tests** — `expect(decide(command, state)).toEqual(facts)` with no
   harness; why the prepare → decide → finalize split makes decisions testable without I/O. These
   need no test doubles at all.
   *(Today: [Developer Guide § Declarative State Machine Pattern](developer-guide.md#declarative-state-machine-pattern-runstatemachine).)*
3. **Level 2: workflow tests on the time-skipping test server** — running the real
   `runStateMachine` driver against `@temporalio/testing`; fast-forwarding a 30-day cart timeout in
   milliseconds; asserting on state transitions rather than implementation details. Activities are
   stubbed here — document which, and why that is the right seam.
4. **Level 3: the cross-domain order journey** — `src/temporal/order-journey.e2e.test.ts` drives
   cart → checkout → OMS → fulfillment on the same time-skipping test server (**not** against live
   containers). Worth documenting its `queryCart` activity, which is a real bridge: it queries the
   live cart workflow through the test environment's client, exactly as the production activity
   does through its own.
5. **Structural tests over the state graph** — `src/temporal/state-graph.test.ts`: no orphan
   states, no dangling `next` targets, every terminal reachable.
6. **Where the seams are** — which layers need doubles and which don't, and why the answer falls
   out of the architecture rather than from testing discipline.
7. **Running and extending the suite** — `npm test`, `npm run test:watch`, `npm run coverage`;
   conventions for co-locating `*.test.ts` files. Note that changes to decider / states files
   **require** co-located tests (`.agent/rules.md`, Temporal Patterns rule 7).
