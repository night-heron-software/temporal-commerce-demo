# Architecture Decision Records

Source code across `src/temporal/` cites these records by number (`ADR-0003`, `ADR-0009`, …).
They are adapted from the parent platform's ADRs of the same numbers — the demo inherits the
decisions; numbering is kept aligned so citations match across both codebases. Only the ADRs the
demo's code actually cites are carried here.

| # | Title | Status |
|---|-------|--------|
| [0003](0003-prepare-decide-finalize-state-machines.md) | `prepare → decide → finalize` state machines on Temporal | Accepted |
| [0009](0009-chassaing-decider-split.md) | Chassaing `decide → events → evolve` split in the pure core | Accepted |
| [0010](0010-async-transition-recording-projection.md) | Async state-transition recording projection | Accepted |
| [0011](0011-workflow-id-and-correlation-tagging.md) | Parseable workflow IDs + Search-Attribute correlation tagging | Accepted |

Numbers are non-contiguous by design: the parent platform's other ADRs (multi-tenancy, payments,
ledger, …) cover subsystems the demo deliberately excludes.
