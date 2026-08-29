export * as Cart from './cart';
export * as Checkout from './checkout';
export * as OMS from './oms';
export * as Fulfillment from './fulfillment';
export * as Inventory from './inventory';
export * as Catalog from './catalog';
export * as Fulfillers from './fulfillers';
export * as Identity from './identity';

export * from './product-type';
export * from './plugin-registry';
export * from './common';
export * as Constants from './constants';
export * from './constants';
export * as Elasticsearch from './elasticsearch';
export * as Communications from './communications';
export * from './activity-tagging';
// NOTE: client-reachable components deliberately deep-import pure modules (elasticsearch,
// communications) instead of using this barrel — it carries Temporal update/query definitions,
// and pulling those into a client bundle is the parent platform's R8/#45 bug class. Keep the
// "Direct module import" comments at those sites.
