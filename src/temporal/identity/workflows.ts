/**
 * Identity Domain Workflows
 *
 * Shopper creation, profile/password updates, and address persistence run as
 * STANDALONE ACTIVITIES (`createShopper`, `updateShopperProfile`,
 * `updateShopperPassword`, `saveShopperAddress`) invoked directly from the client
 * via `executeStandaloneActivity` in `@/lib/temporal-client` — see ADR-0006.
 * No wrapper workflow is needed: each wraps a single repository write with no
 * signals, timers, state, or sequencing, and the activity's own Temporal execution
 * history preserves the audit trail.
 *
 * Anything stateful or multi-step in this domain would belong here as a workflow;
 * none exists today.
 */

export {};
