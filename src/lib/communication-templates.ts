/**
 * Communication Templates — pure subject/body builders for every customer-facing send.
 *
 * Pure domain logic (no I/O, no Temporal imports): the send activities build their
 * content here and route it through `sendEmail()`, the single persistence choke point.
 * Imports the contract type directly by module path (never the contracts barrel — see
 * the PR #41 note in `contracts/communications.ts`).
 */

import type { CommunicationType } from '../temporal/contracts/communications';

export type { CommunicationType };

/** Everything any of the five templates may interpolate; each uses the slice it needs. */
export interface CommunicationTemplateParams {
  /** Human-readable order reference; falls back to orderId when absent (oms sends). */
  confirmationNumber?: string;
  orderId?: string;
  /** Domain order status ('shipped', 'cancelled', …) for the order-status template. */
  status?: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

export interface CommunicationContent {
  subject: string;
  body: string;
}

/** The order reference a customer would recognize: confirmation number, else orderId. */
function orderRef(params: CommunicationTemplateParams): string {
  return params.confirmationNumber ?? params.orderId ?? '';
}

/** "via UPS, tracking number 1Z… (track it at …)" — or '' when there is no tracking yet. */
function trackingLine(params: CommunicationTemplateParams): string {
  if (!params.trackingNumber) return '';
  const carrier = params.carrier ? ` via ${params.carrier}` : '';
  const url = params.trackingUrl ? ` Track it at ${params.trackingUrl}.` : '';
  return `Shipped${carrier}, tracking number ${params.trackingNumber}.${url}`;
}

/**
 * Build the subject and body for one communication type. Exhaustive over
 * `CommunicationType` — adding a type without a template is a compile error.
 */
export function buildCommunication(
  type: CommunicationType,
  params: CommunicationTemplateParams,
): CommunicationContent {
  const ref = orderRef(params);
  switch (type) {
    case 'order-confirmation':
      // Subject wording predates this module (checkout's original sendEmail call) —
      // kept identical so existing log/scrollback expectations stay true.
      return {
        subject: `Order Confirmed - #${ref}`,
        body:
          `Thank you for your order!\n\n` +
          `Your confirmation number is ${ref}. ` +
          `We'll send another email as soon as your items ship.`,
      };
    case 'order-status': {
      const tracking = trackingLine(params);
      return {
        subject: `Order #${ref} update: ${params.status ?? 'updated'}`,
        body:
          `Your order #${ref} is now "${params.status ?? 'updated'}".` +
          (tracking ? `\n\n${tracking}` : ''),
      };
    }
    case 'shipped':
      return {
        subject: `Your order #${ref} has shipped`,
        body: `Good news — your order #${ref} is on its way!\n\n${trackingLine(params)}`,
      };
    case 'delivered':
      return {
        subject: `Your order #${ref} has been delivered`,
        body:
          `Your order #${ref} was delivered. ` +
          `We'd love to hear what you think — reply with your feedback any time.`,
      };
    case 'feedback-thanks':
      return {
        subject: `Thanks for your feedback on order #${ref}`,
        body:
          `Thank you for taking the time to share your feedback on order #${ref}. ` +
          `We read every response.`,
      };
    default: {
      // Exhaustiveness guard: unreachable while the switch covers CommunicationType.
      const unreachable: never = type;
      throw new Error(`Unknown communication type: ${String(unreachable)}`);
    }
  }
}
