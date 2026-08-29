# Architecture Decision Records

This directory holds **Architecture Decision Records (ADRs)** — short, numbered notes capturing a
load-bearing decision and _why_ it was made, so the reasoning behind the architecture is
discoverable instead of scattered across prose that drifts.

An ADR is [MADR](https://adr.github.io/madr/)-style and lightweight: **context → decision →
consequences**. See [`template.md`](template.md).

## Relationship to the parent platform

This demo is a standalone extraction from a larger commerce platform, and its ADRs are
**duplicated from the parent's records of the same number, held as close to identical as this
demo's smaller surface allows.** Numbering is aligned so a citation like `ADR-0024` in the source
means the same decision in both codebases.

Two rules follow from that:

- **Every reference resolves inside this repository.** The set carried here is the transitive
  closure of what this demo's code cites: follow any `ADR-NNNN` link and you land on a file that
  exists. No links point out to the parent.
- **What this demo does not implement is marked, not deleted.** Where a record describes a
  subsystem the demo excludes — multi-tenancy, the accounting ledger, real payments, supplier
  plugins, the Go port — the text is kept and a
  `> **Divergence from the parent platform.**` note at the top of the record says what is and
  is not true here. Deleting the passage would make the two texts diverge silently; marking it
  keeps them diffable and keeps the reader honest.

Numbers are non-contiguous by design: ADR-0002, 0005, 0008, 0013–0015, 0017–0018, 0021, 0027–0028
are the parent's and are not reachable from anything this demo cites.

## Conventions

- **Filename:** `NNNN-kebab-title.md`, zero-padded, matching the parent's. Never renumber.
- **Immutable:** once **Accepted**, don't rewrite the decision. To change course, add a _new_ ADR
  and point the old one's Status at it. This mirrors the parent's rule — an earlier version of
  this file said the opposite ("amend in place, never mint a number"), which is why ADR-0029
  exists as its own record rather than as an edit to ADR-0026.
- **Status:** `Proposed` → `Accepted` → (`Deprecated` | `Superseded`).
- Keep them short. Link out to the detailed design rather than duplicating it.

## Index

| #                                                                | Title                                                                                                | Status                     | Divergence |
|------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|----------------------------|------------|
| [0001](0001-cassandra-elasticsearch-temporal-core-triad.md)      | Cassandra + Elasticsearch + Temporal as the core triad (CQRS)                                        | Accepted                   | yes        |
| [0003](0003-prepare-decide-evolve-state-machines.md)           | `prepare → decide → evolve` state machines on Temporal (no separate domain event-sourcing)         | Accepted (amended by 0024) | yes        |
| [0004](0004-multi-tenant-shared-infrastructure-store-id.md)      | Multi-tenant isolation via shared infrastructure keyed by `store_id`                                 | Accepted                   | yes        |
| [0006](0006-standalone-activities-for-thin-wrappers.md)          | Standalone activities for thin single-activity wrappers                                              | Accepted                   | —          |
| [0007](0007-workflow-mediated-projection-writes.md)              | Workflow-mediated projection writes as a hard gate                                                   | Accepted (amended by 0023) | —          |
| [0009](0009-chassaing-decider-transfer-pilot.md)                 | Chassaing `decide → events → evolve` split, piloted on inventory `transfer`                          | Accepted (amended by 0024) | yes        |
| [0010](0010-async-transition-recording-projection.md)            | Async state-transition recording projection                                                          | Accepted                   | yes        |
| [0011](0011-workflow-id-and-correlation-tagging.md)              | Parseable workflow IDs + Search-Attribute correlation tagging                                        | Accepted                   | yes        |
| [0012](0012-extract-state-machine-framework-package.md)          | Extract the state-machine framework into `@nightheron/state-machine`                                 | Accepted                   | yes        |
| [0016](0016-inventory-write-path-integrity.md)                   | Inventory write-path integrity                                                                       | Accepted                   | yes        |
| [0019](0019-ambient-correlation-propagation.md)                  | correlationId is its own key, propagated ambiently to activities                                     | Accepted                   | yes        |
| [0020](0020-projection-lifecycle-marking.md)                     | Projection docs record their workflow's lifecycle                                                    | Accepted                   | —          |
| [0022](0022-one-lifecycle-id-order-keyed-inventory.md)           | One lifecycle id + order-keyed inventory reservations                                                | Superseded in part by 0031 | yes        |
| [0023](0023-async-projections-via-projection-service.md)         | Async projections via per-store projection-service workflows                                         | Accepted                   | yes        |
| [0024](0024-decider-native-state-machines.md)                    | Decider-native state machines: command/event vocabulary, framework-owned fold, guard phase           | Accepted                   | yes        |
| [0025](0025-phase5-readability-extras-decisions.md)              | Readability extras (clarity plan Phase 5): context views and discriminated responses are NOT adopted | Accepted                   | yes        |
| [0026](0026-per-block-route-declarations.md)                     | Per-block route declarations; per-state route tables derived                                         | Accepted                   | yes        |
| [0029](0029-command-block-authoring-surface-in-the-framework.md) | The CommandBlock authoring surface moves into the framework                                          | Accepted                   | —          |
| [0031](0031-correlation-id-is-its-own-key.md)                    | The correlation id is its own key again (supersedes 0022's correlation clause; restores 0019)        | Accepted                   | yes        |
