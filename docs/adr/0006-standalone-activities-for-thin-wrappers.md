# ADR-0006 — Standalone activities for thin single-activity wrappers

- **Status:** Accepted
- **Tags:** temporal
- **Provenance:** adapted from the parent platform's ADR-0006

## Context

Temporal's **Standalone Activities** (Public Preview; server ≥ 1.31, SDK ≥ 1.17) let a client
execute a single activity directly — `client.activity.execute` — with worker execution, Temporal
retries, and its own execution history, but no workflow. Before this decision, the demo had the
worst of both worlds in the identity domain: single-activity wrapper workflows existed
(`createShopperWorkflow` and friends) but nothing called them, while the API routes wrote shopper
and address data through repositories directly — no worker, no retries, no visibility.

## Decision

Thin single-operation writes run as **standalone activities**, invoked through one insulation
helper — `executeStandaloneActivity` in `src/lib/temporal-client.ts` — so the Public-Preview API
is referenced in exactly one place. Each call passes a business-meaningful `activityId` and typed
correlation Search Attributes (`buildActivityTypedSearchAttributes`,
[ADR-0011](0011-workflow-id-and-correlation-tagging.md)).

**Eligibility rule** (adopted verbatim from the parent platform):

1. Requires signals/queries/timers or holds state → **stays a stateful workflow**.
2. Coordinates multiple activities/steps → **stays an orchestrator workflow**.
3. Wraps a single activity with no sequencing or state → **eligible standalone activity**.

Applied today: the identity domain's `createShopper`, `updateShopperProfile`,
`updateShopperPassword`, and `saveShopperAddress` (all rule 3). The identity worker is
activities-only; its wrapper workflows are deleted. Every other domain has real orchestration and
is untouched.

## Consequences

- **Positive:** the shopper login auto-create and address save now run on the identity worker
  with Temporal's retries and appear in the Temporal UI's **Activities** list (queryable by
  `StoreId`/`Domain`); three dead wrapper workflows and their proxy-stub file are gone; the
  "workflows write" spirit is restored for identity without workflow ceremony.
- **Costs / cautions:**
  - The API is **Public Preview** — re-confirm GA before broadening beyond thin wrappers.
  - Standalone activities are **disabled by default on the server**: the
    `activity.enableStandalone` dynamicconfig gate must be set
    (`infra/temporal/dynamicconfig/development-sql.yaml`). Static checks stay green when it
    isn't — the failure is runtime `UNIMPLEMENTED`. `npm run smoke:standalone` exists precisely
    to catch this.
  - Required the infra migration off the deprecated `temporalio/auto-setup` image (no 1.31+ tags)
    to `temporalio/server:1.31.1` + one-shot bootstrap sidecars.

## Alternatives considered

- **Wire the routes through the existing wrapper workflows** — restores worker execution but
  keeps a workflow whose only job is calling one activity; history noise, extra hop, nothing
  gained. Rejected.
- **Leave direct repository writes** — no retries, no visibility, contradicts the architecture's
  own rule. Rejected.
