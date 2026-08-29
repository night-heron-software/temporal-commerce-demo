import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SHIPPING_ADDRESS_FIELDS,
  computeCheckoutTotal,
  hasUnacknowledgedCartChange,
  validateShippingAddress,
  validateShippingAddressFields,
  validateShippingAddressFormat,
  validateShippingAddressFormatFields,
  type ShippingAddress,
} from './cart';

// Ported from mono packages/contracts/src/cart.test.ts (mono #229/#230 line), with Money
// adapted to this repo's integer cents.

const complete: ShippingAddress = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  address1: '1 Analytical Way',
  city: 'Salt Lake City',
  state: 'UT',
  postalCode: '84101',
  country: 'US',
  email: 'ada@example.com',
};

describe('validateShippingAddress', () => {
  it('returns [] for a complete address (optional fields omitted)', () => {
    expect(validateShippingAddress(complete)).toEqual([]);
  });

  it('reports each missing required field by label', () => {
    for (const [key, label] of REQUIRED_SHIPPING_ADDRESS_FIELDS) {
      expect(validateShippingAddress({ ...complete, [key]: undefined })).toEqual([label]);
    }
  });

  it('treats whitespace-only values as missing', () => {
    expect(validateShippingAddress({ ...complete, city: '   ' })).toEqual(['City']);
  });

  it('lists all missing fields for an empty address, in field order', () => {
    expect(validateShippingAddress({})).toEqual(
      REQUIRED_SHIPPING_ADDRESS_FIELDS.map(([, label]) => label),
    );
  });

  it('never requires address2 or phone', () => {
    expect(validateShippingAddress({ ...complete, address2: '', phone: '' })).toEqual([]);
  });
});

describe('validateShippingAddressFormat', () => {
  const complete = {
    firstName: 'Jeff',
    lastName: 'R',
    address1: '123 Test St',
    city: 'Sandy',
    state: 'UT',
    postalCode: '84070',
    country: 'US',
    email: 'jeff@example.com',
  };

  it('accepts a well-formed US address', () => {
    expect(validateShippingAddressFormat(complete)).toEqual([]);
  });

  it('accepts ZIP+4', () => {
    expect(validateShippingAddressFormat({ ...complete, postalCode: '84070-1234' })).toEqual([]);
  });

  it('rejects a malformed ZIP', () => {
    for (const bad of ['8407', '840700', 'ABCDE', '84070-12']) {
      expect(
        validateShippingAddressFormat({ ...complete, postalCode: bad }),
        `expected ${bad} to be rejected`,
      ).toEqual(['ZIP code must be 5 digits (or ZIP+4)']);
    }
  });

  it('rejects a non-existent state code and accepts lowercase real ones', () => {
    expect(validateShippingAddressFormat({ ...complete, state: 'XX' })).toEqual([
      'State must be a two-letter code (e.g. UT)',
    ]);
    // The UI uppercases via maxLength only; the validator must not care about case.
    expect(validateShippingAddressFormat({ ...complete, state: 'ut' })).toEqual([]);
  });

  it('accepts DC and the USPS territories', () => {
    for (const code of ['DC', 'PR', 'VI', 'GU']) {
      expect(validateShippingAddressFormat({ ...complete, state: code })).toEqual([]);
    }
  });

  it('rejects an email with no @ or no domain dot', () => {
    for (const bad of ['not-an-email', 'a@b', 'a b@c.com', '@c.com']) {
      expect(
        validateShippingAddressFormat({ ...complete, email: bad }),
        `expected ${bad} to be rejected`,
      ).toEqual(['Email address does not look valid']);
    }
  });

  it('rejects a non-US country explicitly rather than silently accepting it', () => {
    expect(validateShippingAddressFormat({ ...complete, country: 'CA' })).toEqual([
      'We currently ship to US addresses only',
    ]);
    expect(validateShippingAddressFormat({ ...complete, country: 'us' })).toEqual([]);
  });

  it('skips absent fields entirely — missing is the required-field check’s job', () => {
    // Both call sites run validateShippingAddress first; reporting "invalid" for a blank field
    // would double up with its "missing" message.
    expect(validateShippingAddressFormat({})).toEqual([]);
    expect(validateShippingAddressFormat({ postalCode: '  ' })).toEqual([]);
  });

  it('reports multiple problems together', () => {
    const problems = validateShippingAddressFormat({
      ...complete,
      postalCode: 'nope',
      state: 'ZZ',
      email: 'bad',
    });
    expect(problems).toHaveLength(3);
  });
});

/**
 * The keyed validators exist because the mono's run-009 shopper filled six fields, pressed Continue, and got
 * three problems in one sentence with nothing saying which box each belonged to. The rules must be
 * the SAME rules the checkout workflow refuses on — these tests pin that, not just the shape.
 */
describe('validateShippingAddressFormatFields', () => {
  const VALID = {
    firstName: 'Test',
    lastName: 'Shopper',
    address1: '100 Test Street',
    city: 'Sandy',
    state: 'UT',
    postalCode: '84070',
    country: 'US',
    email: 'test-shopper@example.test',
  };

  it('agrees with the flat validator on every field, always', () => {
    const cases = [
      VALID,
      { ...VALID, postalCode: '8407' },
      { ...VALID, state: 'Utah' },
      { ...VALID, email: 'notanemail' },
      { ...VALID, country: 'CA' },
      { ...VALID, postalCode: 'nope', state: 'Utah', email: 'notanemail', country: 'CA' },
    ];
    for (const address of cases) {
      const keyed = Object.values(validateShippingAddressFormatFields(address));
      const flat = validateShippingAddressFormat(address);
      // Same problems, same count — the flat form is derived, so a divergence means one of the two
      // grew a rule the other does not have.
      expect(new Set(keyed)).toEqual(new Set(flat));
      expect(keyed).toHaveLength(flat.length);
    }
  });

  it('keeps the flattened order stable — callers join these into one sentence', () => {
    expect(
      validateShippingAddressFormat({
        ...VALID,
        postalCode: 'nope',
        state: 'Utah',
        email: 'notanemail',
        country: 'CA',
      }),
    ).toEqual([
      'ZIP code must be 5 digits (or ZIP+4)',
      'State must be a two-letter code (e.g. UT)',
      'Email address does not look valid',
      'We currently ship to US addresses only',
    ]);
  });

  it('puts each problem on the field it belongs to', () => {
    expect(validateShippingAddressFormatFields({ ...VALID, postalCode: '8407' })).toEqual({
      postalCode: 'ZIP code must be 5 digits (or ZIP+4)',
    });
    expect(validateShippingAddressFormatFields({ ...VALID, email: 'notanemail' })).toEqual({
      email: 'Email address does not look valid',
    });
  });

  it('skips absent fields, so a blank box is not also "malformed"', () => {
    expect(validateShippingAddressFormatFields({ postalCode: '', state: '', email: '' })).toEqual(
      {},
    );
  });
});

describe('validateShippingAddressFields', () => {
  it('reports one message per field — missing wins over malformed', () => {
    // Both would fire for an empty required field; "ZIP code is required" is the useful half.
    const errors = validateShippingAddressFields({ country: 'US' });
    expect(errors.postalCode).toBe('ZIP code is required');
    expect(errors.email).toBe('Email is required');
    expect(errors.country).toBeUndefined();
  });

  it('reports format problems once the field is filled in', () => {
    const errors = validateShippingAddressFields({
      firstName: 'Test',
      lastName: 'Shopper',
      address1: '100 Test Street',
      city: 'Sandy',
      state: 'Utah',
      postalCode: '8407',
      country: 'US',
      email: 'notanemail',
    });
    expect(errors).toEqual({
      state: 'State must be a two-letter code (e.g. UT)',
      postalCode: 'ZIP code must be 5 digits (or ZIP+4)',
      email: 'Email address does not look valid',
    });
  });

  it('is empty for an address the workflow would accept', () => {
    const address = {
      firstName: 'Test',
      lastName: 'Shopper',
      address1: '100 Test Street',
      city: 'Sandy',
      state: 'UT',
      postalCode: '84070',
      country: 'US',
      email: 'test-shopper@example.test',
    };
    expect(validateShippingAddressFields(address)).toEqual({});
    expect(validateShippingAddress(address)).toEqual([]);
    expect(validateShippingAddressFormat(address)).toEqual([]);
  });

  it('covers every required field the workflow checks', () => {
    // If a required field is added to the contract, the form must learn about it too.
    const errors = validateShippingAddressFields({});
    for (const [field] of REQUIRED_SHIPPING_ADDRESS_FIELDS) {
      expect(errors[field], `${field} has no message`).toBeDefined();
    }
  });
});

describe('computeCheckoutTotal', () => {
  it('is subtotal − discounts + live shipping + live tax — the charged amount', () => {
    const total = computeCheckoutTotal(
      { subtotalPrice: 9996, totalDiscounts: 0 },
      { shippingCost: 999, tax: 610 },
    );
    // The mono's run-010 order: shown $107.96, charged $116.05. The helper must say 11605 —
    // headline totals reading `cart.totalPrice` was exactly the shown/charged split.
    expect(total).toBe(11605);
  });

  it('applies discounts before shipping/tax', () => {
    const total = computeCheckoutTotal(
      { subtotalPrice: 10000, totalDiscounts: 1000 },
      { shippingCost: 500, tax: 300 },
    );
    expect(total).toBe(9800);
  });

  it('degrades to the cart-side figure when the checkout state still carries zeros', () => {
    const total = computeCheckoutTotal(
      { subtotalPrice: 9996, totalDiscounts: 0 },
      { shippingCost: 0, tax: 0 },
    );
    expect(total).toBe(9996);
  });
});

describe('hasUnacknowledgedCartChange — the cart-changed predicate', () => {
  // Both numbers are CHECKOUT-owned. Comparing a cart-side version against a checkout-side
  // baseline races two workflows read by two independent RPCs, so any timing difference
  // between them reads as a content change.
  it('is false when the priced version equals the approved one', () => {
    expect(hasUnacknowledgedCartChange({ cartVersion: 3, cartVersionAcknowledged: 3 })).toBe(false);
  });

  it('is true when the cart moved past what the shopper approved', () => {
    expect(hasUnacknowledgedCartChange({ cartVersion: 4, cartVersionAcknowledged: 3 })).toBe(true);
  });

  it('is false when the approved version is somehow ahead (never guess a change)', () => {
    expect(hasUnacknowledgedCartChange({ cartVersion: 3, cartVersionAcknowledged: 4 })).toBe(false);
  });

  it('is false on missing information rather than defaulting either side to 0', () => {
    expect(hasUnacknowledgedCartChange(null)).toBe(false);
    expect(hasUnacknowledgedCartChange(undefined)).toBe(false);
    expect(hasUnacknowledgedCartChange({ cartVersionAcknowledged: 3 })).toBe(false);
    expect(hasUnacknowledgedCartChange({ cartVersion: 3 })).toBe(false);
  });
});
