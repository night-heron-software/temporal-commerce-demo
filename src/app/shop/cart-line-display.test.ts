import { describe, it, expect } from 'vitest';
import { cartLineTitle, cartLineLabel } from './cart-line-display';

const VARIANT_ID = '062fd3d8-cf8c-4fdb-b528-f942d7e8f432';

describe('cartLineTitle', () => {
  it('prefers the snapshot product title', () => {
    expect(
      cartLineTitle({
        variantId: VARIANT_ID,
        productTitle: 'Bald Eagle Portrait — Champion Hoodie [Simulated]',
        variantTitle: 'S / White',
      }),
    ).toBe('Bald Eagle Portrait — Champion Hoodie [Simulated]');
  });

  it('falls back to a labelled id for a line that predates the snapshot', () => {
    expect(cartLineTitle({ variantId: VARIANT_ID })).toBe(`Variant ${VARIANT_ID}`);
  });

  it('does not render the raw id unlabelled — and never as a sku', () => {
    // The fallback must never read as a bare UUID (the review page's old fallback) or as
    // `SKU: <id>` (the drawer's old label — a variantId is not a sku). Both defects are the
    // reason this module exists.
    expect(cartLineTitle({ variantId: VARIANT_ID })).not.toBe(VARIANT_ID);
    expect(cartLineTitle({ variantId: VARIANT_ID })).not.toContain('SKU');
  });

  it('treats an empty product title as absent', () => {
    // The snapshot resolver omits rather than blanks, so an empty string is corrupt input —
    // rendering it would produce a nameless row, which is worse than the id.
    expect(cartLineTitle({ variantId: VARIANT_ID, productTitle: '' })).toBe(
      `Variant ${VARIANT_ID}`,
    );
  });
});

describe('cartLineLabel', () => {
  it('joins title and variant label for one-line surfaces', () => {
    expect(
      cartLineLabel({
        variantId: VARIANT_ID,
        productTitle: 'Champion Hoodie',
        variantTitle: 'S / White',
      }),
    ).toBe('Champion Hoodie — S / White');
  });

  it('omits the separator when the line has no variant label', () => {
    expect(cartLineLabel({ variantId: VARIANT_ID, productTitle: 'Champion Hoodie' })).toBe(
      'Champion Hoodie',
    );
  });

  it('falls back with the id when nothing was snapshotted', () => {
    expect(cartLineLabel({ variantId: VARIANT_ID })).toBe(`Variant ${VARIANT_ID}`);
  });
});
