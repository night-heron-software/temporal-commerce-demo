/**
 * Plugin Registry Interface
 *
 * Defines how the platform discovers and accesses ProductTypePlugin instances.
 * The implementation lives in the lib/ directory; this file provides
 * only the contract so that domain code can depend on it without pulling
 * in infrastructure.
 */

import type { ProductTypePlugin } from './product-type';

export interface PluginRegistry {
  /** Register a plugin instance. Called during worker/app initialization. */
  register(plugin: ProductTypePlugin): void;

  /** Look up a plugin by its typeId (e.g., 'pod', 'simulated', 'dropship'). */
  getPlugin(typeId: string): ProductTypePlugin | undefined;

  /**
   * Resolve the plugin responsible for a given variant.
   * Looks up the variant's product type and returns the matching plugin.
   * Throws if no plugin is registered for the product type.
   */
  getPluginForVariant(variantId: string): Promise<ProductTypePlugin>;

  /** Return all registered plugins. */
  getAllPlugins(): ProductTypePlugin[];
}
