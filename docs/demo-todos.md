# Demo — Deferred Improvements

Numbered, monotonic backlog for `temporal-commerce-demo`. Entries are raised by validation runs
(`docs/private/validation-session-*.md`) and by review; each carries the problem, a preferred
approach, and the location to touch. Closed entries keep their number and gain a resolution note
rather than being deleted — the numbers are cited from session records.

This repo previously had no backlog of its own; findings were either fixed live or tracked in the
mono's [`docs/nightheron-mono-todos.md`](./nightheron-mono-todos.md) (a copy of which is vendored
here for reference). Demo-specific items belong in THIS file.

---

## #1 — Cart Drawer Shows Variant Ids, Not Product Names and Options

**Found 2026-08-11** (validation session `2026-08-11-006`, Station 2). The cart drawer identifies
lines by variant identifier rather than by what the shopper actually bought. A line should read as
the product title plus its option labels, e.g.

> **California Surf — Unisex Jersey Short Sleeve Tee [Simulated]**
> Baby Blue / 4XL

**Problem:** a cart that names its lines by id is unreadable as a shopping surface, and it makes
every validation/demo walkthrough harder — the operator has to cross-reference ids to know which
line is which (this run's Station 2 needed exactly that).

**Preferred approach:** the order-time snapshot fields already exist on the cart line
(`productTitle` / `variantTitle` / `optionLabels` are captured at add-to-cart in the mono's cart
contracts and mirrored here) — render those, falling back to the id only when a line genuinely
carries no snapshot. Include the fulfillment-type suffix (`[Simulated]`) that the demo uses to
make the simulated catalog legible. Verify against a line added before and after any snapshot
change, so a blank title is visibly a data bug rather than a silent id.

**Location:** the cart drawer component under `src/components/` (cart drawer / line item),
plus whatever cart line-item type it reads.

**Related:** mono backlog `#54` records the same defect class in nightheron-mono ("Cart Drawer
Shows Variant UUIDs Labeled 'SKU', No Product Titles") — fix both, or port one fix.

---

## #2 — Admin Interface: Show Full UUIDs, With Copy Buttons

**Found 2026-08-11** (validation session `2026-08-11-006`, Station 2). Admin surfaces abbreviate
identifiers (cart ids, order ids, workflow ids, correlation ids), so an operator cannot read or
copy the value that every downstream tool needs.

**Problem:** the demo's `/admin` is deliberately a **developer-facing** surface (recorded as an
intentional divergence in the sync ledger) — its job is to hand you ids you will paste into
`temporal workflow describe`, a cqlsh query, or a chat with an agent. Truncation defeats that job
outright: this run's operator had to source the cartId by hand to start Station 2.

**Preferred approach:** render identifiers in full, in a monospace face, each with a
click-to-copy affordance (and a copied-confirmation). Apply uniformly across orders, carts,
inventory, and search views, including the dev tools (`/dev/order-trace`, `/dev/logs`) so the id
in the UI is always the id you can paste. If full ids crowd a table column, prefer wrapping or a
dedicated id column over truncation — do not solve it by hiding the value.

**Location:** admin views under `src/app/admin/` and the dev tools under `src/app/dev/`; a single
shared `<CopyableId>`-style component is the natural home so the behavior is consistent and gets
fixed once.
