# ADR-0015 — Updates (and `updateWithStart`) over signals for interactive entity mutation

- **Status:** Accepted
- **Date:** 2026-07-16
- **Deciders:** Jeff Romine (retroactive record of a decision in force since the interaction model settled)
- **Tags:** temporal, interaction-model, storefront
- **Provenance:** duplicated from the parent platform's ADR-0015; held as close to identical as this demo's smaller surface allows.


> **Divergence from the parent platform.** Fully in force: every shopper interaction here is an
> `executeUpdate` (`cartUpdate`, `setShippingUpdate`, `setPaymentUpdate`, `submitOrderUpdate`,
> `acknowledgeCartChangeUpdate`, `submitFeedbackUpdate`); signals remain for workflow-to-workflow
> notification (`checkoutCompletedSignal`, fulfillment → OMS status).

## Context

Interactive entity changes — modifying a cart, editing a checkout — are driven from the storefront
UI, which needs two things from every mutation: validation (did it work, and if not, why?) and the
resulting entity state, in the response. Temporal's examples lean on **signals**, which are
fire-and-forget: a signal cannot return a validation error or fresh state, so a signal-based UI must
poll a query after every write and guess when it has caught up.

Entity creation compounds the problem. A dedicated "create" path followed by mutation calls means
two code paths (first interaction vs. every later one) and a race — two browser tabs adding the
first item to the same cart can both attempt the create.

This is the modeling decision that took longest to converge on; no sample we found put it front and
center, so it is recorded here.

## Decision

We will expose interactive entity mutations as **workflow updates**, and start entity workflows with
**`executeUpdateWithStart`** using a `WithStartWorkflowOperation` with
`workflowIdConflictPolicy: 'USE_EXISTING'` — create-or-update is atomic and there is a single code
path whether the workflow exists or not. Next.js Server Actions call this directly; there is no
REST/BFF layer between the UI and the cluster. (Client utilities are imported from
`@nightheron/infrastructure`, per invariant 3.)

Signals remain for genuinely one-way traffic: workflow-to-workflow nudges (a cart telling its
checkout child to recompute) and singleton services ingesting notification streams.

Rule of thumb: **updates when a caller needs an answer, signals when nobody's waiting.**

## Consequences

- **Positive:** validation and the new state come back in one round trip — no query polling, no
  read-your-writes guessing. No "create cart" endpoint, no existence checks, no first-interaction
  race. Domain validation errors surface synchronously in the UI.
- **Negative / costs:** update handlers demand drainage discipline — `allHandlersFinished` must be
  awaited before `continueAsNew` — which the state-machine driver handles once for every domain.
  Updates also serialize through the driver's FIFO loop, a deliberate constraint (one class of
  interleaving bugs removed).
- **Follow-ups:** none open; the pattern is baked into the authoring framework
  (`@nightheron/state-machine`) and the `nightheron-temporal` skill.

## Alternatives considered

- **Signals + query polling** — rejected: fire-and-forget cannot carry validation or fresh state;
  the UI is left polling and guessing.
- **Explicit create endpoint, then updates** — rejected: two code paths and a create/exists race
  between concurrent tabs.
- **REST/BFF service with its own store** — rejected: reintroduces exactly the state drift and
  reconciliation the workflow-as-entity model exists to remove.
