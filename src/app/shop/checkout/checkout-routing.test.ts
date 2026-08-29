/**
 * Tests for checkout step routing (the parent platform's mono-issue-0318, the CLASS).
 *
 * The centrepiece is the **fixed-point property**: for every step, the canonical path for that step
 * must not itself redirect. A routing relation that violates it has a cycle, and a cycle is exactly
 * the bug — #0318 and #0326 were both a shopper bouncing between two surfaces forever.
 *
 * It is asserted over the WHOLE `CheckoutStep` union rather than a hand-listed sample, so a step
 * added to the flow later cannot quietly skip it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Cart } from '@/temporal/contracts';

import { CHECKOUT_PATHS, destinationFor, pathForStep, routeForStep } from './checkout-routing';

/** Every step the contract defines. Kept exhaustive by the compile-time check below. */
const ALL_STEPS = [
  'validating',
  'shipping',
  'payment',
  'review',
  'processing',
  'complete',
  'failed',
  'cancelled',
] as const satisfies readonly Cart.CheckoutStep[];

// If `CheckoutStep` gains a member, this stops compiling — the exhaustiveness net for the property
// below, which is only meaningful if it covers every step.
type Missing = Exclude<Cart.CheckoutStep, (typeof ALL_STEPS)[number]>;
const _exhaustive: Missing extends never ? true : Missing = true;
void _exhaustive;

describe('the fixed-point property — the routing relation has no cycles', () => {
  it.each(ALL_STEPS)('a shopper on the canonical path for "%s" is told to STAY', (step) => {
    const belongs = pathForStep(step);
    if (belongs === null) return; // not an interactive surface; nothing to route
    // THE property. If this ever redirects, the shopper is on the page this module sent them to
    // and is being sent somewhere else — which is the loop, stated exactly.
    expect(routeForStep(step, belongs)).toEqual({ kind: 'stay' });
  });

  it('every redirect settles in ONE hop, from any starting surface', () => {
    const surfaces = Object.values(CHECKOUT_PATHS);
    for (const step of ALL_STEPS) {
      for (const from of surfaces) {
        const first = routeForStep(step, from);
        if (first.kind === 'stay') continue;
        // Follow it once. A second redirect would mean the destination disagrees with the step
        // that chose it — two guards arguing, which is #0318's shape between pages.
        expect(routeForStep(step, first.to), `${step} from ${from} did not settle`).toEqual({
          kind: 'stay',
        });
      }
    }
  });
});

describe('the two parent-platform instances, as regressions', () => {
  it('mono-issue-0318: a machine on "payment" is never sent to review', () => {
    expect(pathForStep('payment')).toBe(CHECKOUT_PATHS.payment);
    expect(destinationFor({ step: 'payment' })).toBe(CHECKOUT_PATHS.payment);
  });

  it('mono-issue-0326: a machine on "review" is never sent to payment', () => {
    expect(pathForStep('review')).toBe(CHECKOUT_PATHS.review);
    expect(destinationFor({ step: 'review' })).toBe(CHECKOUT_PATHS.review);
  });
});

describe('pathForStep', () => {
  it('treats validating as the shipping surface', () => {
    expect(pathForStep('validating')).toBe(CHECKOUT_PATHS.shipping);
    expect(pathForStep('shipping')).toBe(CHECKOUT_PATHS.shipping);
  });

  it('returns null for terminal steps rather than falling back to shipping', () => {
    // Silently sending a shopper who just paid back to the address form is the failure this
    // pins. `complete` belongs to the confirmation page, whose href this module cannot compose.
    for (const step of ['processing', 'complete', 'failed', 'cancelled'] as const) {
      expect(pathForStep(step), step).toBeNull();
    }
  });

  it('sends an absent step to the start, but an UNKNOWN one nowhere', () => {
    expect(pathForStep(undefined)).toBe(CHECKOUT_PATHS.shipping);
    expect(pathForStep(null)).toBe(CHECKOUT_PATHS.shipping);
    expect(pathForStep('someday-new-step' as Cart.CheckoutStep)).toBeNull();
  });
});

describe('routeForStep carries a reason, so a bounce is never silent', () => {
  it('names the step and the destination', () => {
    const route = routeForStep('payment', CHECKOUT_PATHS.review);
    expect(route.kind).toBe('redirect');
    if (route.kind !== 'redirect') return;
    expect(route.to).toBe(CHECKOUT_PATHS.payment);
    // #0318 presented as "the button doesn't work" precisely because the bounce said nothing.
    expect(route.reason).toContain('payment');
    expect(route.reason).toContain(CHECKOUT_PATHS.payment);
  });

  it('stays put for a step it does not route, rather than bouncing mid-submit', () => {
    expect(routeForStep('processing', CHECKOUT_PATHS.review)).toEqual({ kind: 'stay' });
    expect(routeForStep('complete', CHECKOUT_PATHS.review)).toEqual({ kind: 'stay' });
  });
});

// ── The ratchet ────────────────────────────────────────────────────────────────
//
// Everything above proves the CURRENT routing relation is sound. This proves the next commit
// cannot quietly reintroduce the class, which is the difference between fixing two bugs and
// fixing the class. Scanning source is cruder than an ESLint rule and buys the same protection.
//
// Scope: the checkout surfaces AND the components dir — CartDrawer carried one of this repo's
// five literal call sites, so a checkout-dir-only scan would have a named offender outside it.
describe('no surface may name a checkout step path directly', () => {
  const SCAN_DIRS = [path.join(__dirname), path.join(__dirname, '..', '..', '..', 'components')];

  const sources = (): Array<{ file: string; text: string }> => {
    const out: Array<{ file: string; text: string }> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          out.push({ file: full, text: fs.readFileSync(full, 'utf8') });
        }
      }
    };
    for (const dir of SCAN_DIRS) walk(dir);
    return out;
  };

  it('finds the checkout sources at all — a scan over nothing proves nothing', () => {
    // The control. A glob that matches no files passes every assertion below it.
    const files = sources();
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.file.endsWith(`review${path.sep}page.tsx`))).toBe(true);
    expect(files.some((f) => f.file.endsWith('CartDrawer.tsx'))).toBe(true);
  });

  it('routes through checkout-routing instead of a literal path', () => {
    // The pattern that was mono-issue-0318 and mono-issue-0326: a router call naming a checkout
    // step path, independent of any state. Comments are stripped first — fixes deliberately
    // quote the old literal in a comment to explain what went wrong, and those must stay legible.
    const offenders: string[] = [];
    for (const { file, text } of sources()) {
      if (file.endsWith('checkout-routing.ts')) continue; // the one place that owns the paths
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      // The three STEP surfaces only. `/shop/checkout/confirmation` is deliberately not in the
      // class: it is a terminal page whose href carries order parameters, which this module
      // refuses to compose (see pathForStep's null-for-terminal note) — so composing it at the
      // call site is correct, not a violation.
      const re =
        /router\s*\.\s*(?:push|replace)\s*\(\s*['"`]\/shop\/checkout\/(?:shipping|payment|review)/g;
      if (re.test(code)) offenders.push(path.basename(file));
    }
    expect(
      offenders,
      'Derive the destination from the machine: `destinationFor(state)` or `pathForStep(step)`. ' +
        'A literal path is a claim about the machine that nothing verifies (mono-issue-0318).',
    ).toEqual([]);
  });
});
