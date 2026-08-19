import { getElasticsearchClient } from '@/lib/es-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('variant-display');

/**
 * Display snapshot for a cart line, resolved at add-to-cart (backlog #1 / remediation R1).
 * Field names mirror the optional snapshot on `CartItem` (contracts/cart.ts) so the
 * resolution spreads straight into the `addItem` command.
 */
export interface VariantDisplay {
  productId: string;
  productTitle: string;
  /** Option labels joined for display, e.g. "Baby Blue / 4XL". */
  variantTitle: string;
  optionLabels: string[];
  thumbnailUrl: string;
}

/** Extract the human label from either option shape the catalog stores. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function optionLabel(option: any): string | null {
  // Cassandra flat format: { option_type, label, attributes }
  if (typeof option?.label === 'string') return option.label;
  // OptionSelection format: { optionType, value: { label | name } }
  const value = option?.value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.label === 'string') return v.label;
    if (typeof v.name === 'string') return v.name;
  }
  return null;
}

/**
 * Resolve a variant's display snapshot from the products index (nested query on
 * `variants.id`). Returns null when the variant cannot be found or the lookup fails —
 * the caller then adds the line WITHOUT a snapshot and the UI falls back to showing
 * the variantId, visibly (a blank title is a data bug, not a silent id — backlog #1).
 *
 * The seeded product names already carry the "[Simulated]" suffix, so `productTitle`
 * needs no decoration here.
 */
export async function resolveVariantDisplay(variantId: string): Promise<VariantDisplay | null> {
  try {
    const client = getElasticsearchClient();
    const response = await client.search({
      index: 'products',
      query: {
        nested: {
          path: 'variants',
          query: { term: { 'variants.id': variantId } },
        },
      },
      size: 1,
    });

    const hit = response.hits.hits[0];
    if (!hit) {
      log.warn({ variantId }, 'Variant not found in products index — cart line gets no snapshot');
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const source = hit._source as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const variant = (source.variants || []).find((v: any) => (v.variantId || v.id) === variantId);
    if (!variant) {
      log.warn({ variantId, productId: source.id }, 'Product matched but variant row missing');
      return null;
    }

    const optionLabels: string[] = (variant.options || [])
      .map(optionLabel)
      .filter((l: string | null): l is string => l !== null);

    return {
      productId: source.id,
      productTitle: source.name || '',
      variantTitle: optionLabels.join(' / '),
      optionLabels,
      thumbnailUrl:
        variant.images?.['front'] || variant.frontImageUrl || source.defaultVariantImageUrl || '',
    };
  } catch (e) {
    log.warn(
      { variantId, err: e },
      'Variant display resolution failed — cart line gets no snapshot',
    );
    return null;
  }
}
