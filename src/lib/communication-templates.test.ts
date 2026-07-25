/**
 * Communication template tests — one per type asserting the subject and the
 * load-bearing body fragments (confirmation number, tracking number, status wording),
 * plus tracking-info interpolation and the runtime exhaustiveness guard.
 */
import { describe, expect, it } from 'vitest';

import { buildCommunication, type CommunicationType } from './communication-templates';

describe('buildCommunication', () => {
  it('order-confirmation: keeps the original checkout subject wording and cites the confirmation number', () => {
    const { subject, body } = buildCommunication('order-confirmation', {
      confirmationNumber: 'M5XCXU2Y',
    });
    expect(subject).toBe('Order Confirmed - #M5XCXU2Y');
    expect(body).toContain('M5XCXU2Y');
    expect(body).toContain('Thank you for your order');
  });

  it('order-status: carries the status wording, falling back to orderId as the reference', () => {
    const { subject, body } = buildCommunication('order-status', {
      orderId: 'o-1',
      status: 'cancelled',
    });
    expect(subject).toBe('Order #o-1 update: cancelled');
    expect(body).toContain('"cancelled"');
    expect(body).not.toContain('tracking');
  });

  it('order-status: embeds tracking number and carrier when present', () => {
    const { body } = buildCommunication('order-status', {
      orderId: 'o-1',
      status: 'shipped',
      carrier: 'UPS',
      trackingNumber: '1Z999',
    });
    expect(body).toContain('via UPS');
    expect(body).toContain('tracking number 1Z999');
  });

  it('shipped: prefers the confirmation number and interpolates the full tracking info', () => {
    const { subject, body } = buildCommunication('shipped', {
      confirmationNumber: 'CONF-1',
      orderId: 'o-1',
      carrier: 'USPS',
      trackingNumber: 'TRK-42',
      trackingUrl: 'https://track.example/TRK-42',
    });
    expect(subject).toBe('Your order #CONF-1 has shipped');
    expect(body).toContain('via USPS');
    expect(body).toContain('tracking number TRK-42');
    expect(body).toContain('https://track.example/TRK-42');
  });

  it('delivered: announces delivery and invites feedback', () => {
    const { subject, body } = buildCommunication('delivered', { confirmationNumber: 'CONF-1' });
    expect(subject).toBe('Your order #CONF-1 has been delivered');
    expect(body).toContain('delivered');
    expect(body).toContain('feedback');
  });

  it('feedback-thanks: thanks the customer and references the order', () => {
    const { subject, body } = buildCommunication('feedback-thanks', { orderId: 'o-1' });
    expect(subject).toBe('Thanks for your feedback on order #o-1');
    expect(body).toContain('o-1');
    expect(body).toContain('Thank you');
  });

  it('throws on an unknown type (runtime backstop behind the never guard)', () => {
    expect(() => buildCommunication('carrier-pigeon' as CommunicationType, {})).toThrow(
      /Unknown communication type/,
    );
  });
});
