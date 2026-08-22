# ADR-0012 — Extract the state-machine framework into `@nightheron/state-machine`

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Jeff Romine
- **Tags:** temporal, state-machine, packaging
- **Provenance:** duplicated from the parent platform's ADR-0012; held as close to identical as this demo's smaller surface allows.

> **Divergence from the parent platform.** The demo does not consume the extracted package: it **vendors** `nightheron-state-machine/src` into `src/temporal/framework/`, held byte-identical (see `docs/reference/mono-sync-*.md`). The extraction rationale is what explains that directory's existence.

## Context

The prepare → decide → evolve framework (ADR-0003, ADR-0009, ADR-0010) grew up inside
`@nightheron/infrastructure` under the `./framework` subpath. It has no infrastructure concerns of
its own — it is workflow-side code with exactly two runtime dependencies (`@temporalio/workflow`,
`@temporalio/common`) plus one internal coupling: the transition recorder read
`SEARCH_ATTRIBUTE_KEYS` and `parseWorkflowId` from `@nightheron/contracts` to resolve
tenant/correlation (ADR-0011). We want to reuse the framework in other Temporal TypeScript
projects and eventually publish it as a standalone open-source library.

## Decision

We will move the framework to its own workspace package, **`@nightheron/state-machine`**
(`packages/state-machine`), and sever the contracts coupling with an **identity-resolver seam**:

- `TransitionRecordingConfig.identity?: TransitionIdentityResolver` — resolves the workflow's
  `{ tenantId, tags }`. The default, `conventionIdentityResolver()`, reads the tenant from the
  `StoreId` Search Attribute (configurable), collects every other custom keyword Search Attribute
  into `tags`, and falls back to parsing the dot-delimited `{tenant}.{domain}.{entity}` workflow-ID
  convention — reproducing the previous contracts-based behavior with zero per-domain wiring.
- The persisted wire type is now the generic **`TransitionPersistRecord`** (`tenantId` + free-form
  `tags`), owned by the framework and imported by infrastructure's node-side recorder, which maps
  `tags.Domain` / `tags.CorrelationId` / `tags.OrderId` to the existing Cassandra columns. The two
  hand-synced copies of this type are gone.
- The recorder's activity name is exported as `PERSIST_TRANSITIONS_ACTIVITY`
  (`persistWorkflowTransitions`); hosts register an implementation on workers that run recorded
  machines.

The package lives in the standalone **`nightheron-state-machine`** sibling repo, consumed via the
existing `file:` sibling-repo pattern (like the pod/designer plugins). Public rename and npm
publish are deliberate later steps; until then the placeholder name stays.

`@nightheron/contracts` keeps `buildWorkflowId` / `buildWorkflowStartOptions` /
`SEARCH_ATTRIBUTE_KEYS` — those encode nightheron's domain vocabulary (closed `WorkflowDomain`
union, `correlationId ?? cartId` defaulting) and are consumed by the storefront; they are not
framework material.

> **Amended by [ADR-0019](0019-ambient-correlation-propagation.md).** The `correlationId ?? cartId`
> defaulting described above was removed: `correlationId` is now required, with an explicit
> `undefined` as the opt-out for correlation-less singletons. The split of responsibilities
> (contracts vs framework) is unchanged.

## Consequences

- **Positive:** the framework is standalone-ready (no `@nightheron/*` imports); one wire type
  instead of two hand-synced copies; domains depend on `@nightheron/state-machine` explicitly
  instead of reaching through infrastructure; other Temporal projects can adopt the framework.
- **Negative / costs:** one more workspace package in the build chain
  (state-machine → infrastructure → domains); the persist activity's wire format changed
  (`storeId`/`domain`/`correlationId`/`orderId` → `tenantId`/`tags`) — acceptable pre-production
  with workflow- and node-side shipping together.
- **Follow-ups:** standalone repo spin-out + CI sibling checkout; public rename + npm publish;
  flip `@temporalio/*` to peerDependencies at spin-out; migrate the resolver off the deprecated
  `workflowInfo().searchAttributes` to `typedSearchAttributes`.

## Alternatives considered

- **Move the workflow-ID/Search-Attribute helpers into the framework** (contracts re-exports):
  rejected — half the convention is irreducibly nightheron-specific and the storefront imports it;
  contracts must not depend on a Temporal-workflow-adjacent package.
- **Module-level identity registration** (host calls a `setIdentityResolver()` once): rejected —
  registration must happen inside each domain's workflow bundle, which is more wiring and more
  implicit than a config default.
- **Keep the contracts dependency until spin-out:** rejected — the seam is small, and deferring it
  would make the standalone move a breaking two-step for consumers.
