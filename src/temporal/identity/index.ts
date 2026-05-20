/**
 * Identity Domain
 *
 * Barrel export for the identity domain package.
 * Re-exports DB repositories and activity implementations
 * for use by worker entry points and integration tests.
 */

// DB Repositories
export { ShopperRepository } from './db/shopper-repository';
export { AddressRepository } from './db/address-repository';

// Activity implementations (for worker registration)
export * as activities from './activities-impl';

// Worker entry point
export { default as identityWorker } from './worker';
