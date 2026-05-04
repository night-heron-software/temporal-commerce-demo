/**
 * Logger — Simple structured logger for the demo
 *
 * Uses pino for structured JSON logging in production,
 * with pino-pretty for human-readable dev output.
 */

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    transport: isDev ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  });
}

export const logger = createLogger('temporal-commerce-demo');
