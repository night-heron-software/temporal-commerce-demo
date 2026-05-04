/**
 * Email Service — Console-only stub for demo
 *
 * In the full platform this sends via Mailgun/SendGrid.
 * For the demo, it logs to console.
 */

import { createLogger } from './logger';

const log = createLogger('email');

export interface SendEmailParams {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  log.info({ to: params.to, subject: params.subject }, '📧 [DEMO] Email sent (console only)');
}
