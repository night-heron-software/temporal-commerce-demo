/**
 * Centralized Logger
 *
 * Pino-based structured logger for both the Next.js server and the Temporal workers.
 *
 * Streams (fanned out via pino.multistream):
 *   - stdout: pino-pretty (colorized) in development, raw JSON in production
 *   - file:   JSON written to LOG_DIR/demo-<service>-<date>.log (always, except under vitest)
 *   - errors: level >= 50 forwarded to the `system_errors` Elasticsearch index
 *
 * Configuration:
 *   LOG_LEVEL           — pino level (default: 'debug' in dev, 'info' in prod)
 *   LOG_DIR             — directory for log files (default: './logs')
 *   LOG_SERVICE         — filename tag, set by the npm scripts (web | workers | scripts)
 *   LOG_RETENTION_DAYS  — prune log files older than this (default: 7)
 *   LOG_ES_ERRORS       — set 'false' to disable the Elasticsearch error stream
 *
 * Usage:
 *   import { createLogger } from '@/lib/logger';
 *   const log = createLogger('checkout');
 *   log.info({ orderId }, 'Order created');
 */

import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const isDev = process.env.NODE_ENV !== 'production';
const level = (process.env.LOG_LEVEL || (isDev ? 'debug' : 'info')) as pino.Level;

/**
 * Under vitest both side-effecting streams are disabled: the suite is contractually
 * container-free (AGENTS.md) and must not create files in the repo or dial Elasticsearch.
 */
const isTest = !!process.env.VITEST;

/**
 * Filename tag so the storefront and the workers — which share a working directory under
 * `npm run dev:up` — do not append to the same file. Set inline by the npm scripts.
 */
const service = process.env.LOG_SERVICE || 'app';
const logDir = path.resolve(process.cwd(), process.env.LOG_DIR || 'logs');
const retentionDays = Number(process.env.LOG_RETENTION_DAYS ?? 7);

// ── File destination ──────────────────────────────────────────────────────────
/** Delete log files older than LOG_RETENTION_DAYS. Best-effort; never throws. */
function pruneOldLogs(): void {
  try {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(logDir)) {
      const match = /^demo-.*-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!match) continue;
      if (Date.parse(match[1]) < cutoff) fs.unlinkSync(path.join(logDir, name));
    }
  } catch {
    // best-effort — a failed prune must never stop the process from logging
  }
}

/**
 * A write stream that opens on first use rather than at import.
 *
 * `next build` evaluates route modules, which reach this file through api-utils.ts — an eager
 * `mkdirSync` would create `logs/` as a build side effect. `src/lib/feature-flags.ts` defers
 * its `mkdirSync` for the same reason.
 */
function createLazyFileStream(): pino.DestinationStream {
  let sink: fs.WriteStream | null = null;

  return {
    write(msg: string) {
      if (!sink) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          pruneOldLogs();
          const today = new Date().toISOString().slice(0, 10);
          sink = fs.createWriteStream(path.join(logDir, `demo-${service}-${today}.log`), {
            flags: 'a',
          });
          // A broken log file must not take the process down with it.
          sink.on('error', () => {});
        } catch {
          return;
        }
      }
      sink.write(msg);
    },
  };
}

// ── Streams ───────────────────────────────────────────────────────────────────
const streams: pino.StreamEntry[] = [];

if (!isTest) {
  // File — always raw JSON (machine-readable, grep-friendly)
  streams.push({ level, stream: createLazyFileStream() });
}

if (isDev) {
  // stdout — pretty-printed with colour in development.
  //
  // multistream is incompatible with pino's worker-thread `transport`, so pino-pretty is
  // required synchronously here. `component` is rendered as a bracketed prefix to preserve the
  // output shape pino gave the old `name` binding for free.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pretty = require('pino-pretty');
    streams.push({
      level,
      stream: pretty({
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,component',
        messageFormat: '[{component}] {msg}',
      }),
    });
  } catch {
    // pino-pretty missing (e.g. `npm ci --omit=dev` then `npm run dev`) — plain stdout still works
    streams.push({ level, stream: process.stdout });
  }
} else {
  // Production: raw JSON to stdout for log-aggregation pipelines
  streams.push({ level, stream: process.stdout });
}

// ── Error index stream ────────────────────────────────────────────────────────
export interface SystemErrorDocument {
  errorId: string;
  timestamp: string;
  level: 'error' | 'fatal';
  message: string;
  component?: string;
  storeId?: string;
  stack?: string;
  context: Record<string, unknown>;
}

/**
 * Shape one pino JSON line into a `system_errors` document, or null if it is not an
 * error/fatal line. Pure and exported so it can be tested without Elasticsearch.
 */
export function toSystemErrorDocument(line: string): SystemErrorDocument | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof parsed.level !== 'number' || parsed.level < 50) return null;

  const { level: lvl, msg, time, component, storeId, err, error: errField, ...rest } = parsed;

  // The Temporal SDK passes errors under `error`; everything else uses pino's reserved `err`.
  const errObj = (err ?? errField) as Record<string, unknown> | undefined;

  return {
    errorId: randomUUID(),
    timestamp: typeof time === 'number' ? new Date(time).toISOString() : new Date().toISOString(),
    level: lvl === 60 ? 'fatal' : 'error',
    message: typeof msg === 'string' ? msg : '',
    component: typeof component === 'string' ? component : undefined,
    storeId: typeof storeId === 'string' ? storeId : undefined,
    stack: typeof errObj?.stack === 'string' ? errObj.stack : undefined,
    context: { ...rest, ...(errObj ? { err: errObj } : {}) },
  };
}

/**
 * Cap concurrent indexing requests. api-utils.ts logs every API error, so a hot failure loop
 * (Cassandra down → every request 500s) would otherwise fan out unbounded promises at an
 * Elasticsearch that may itself be down.
 */
const MAX_IN_FLIGHT = 100;
let inFlight = 0;

/**
 * Forwards error/fatal lines to the `system_errors` index so they are queryable from
 * /dev/system-errors. Fire-and-forget: never throws, never blocks pino.
 *
 * The ES client is required lazily so processes that never log an error never construct one.
 * Import './es-client' directly, never the '@/lib' barrel — the barrel re-exports this module.
 */
const errorIndexStream: pino.DestinationStream = {
  write(line: string) {
    if (isTest || process.env.LOG_ES_ERRORS === 'false') return;
    if (inFlight >= MAX_IN_FLIGHT) return;

    const doc = toSystemErrorDocument(line);
    if (!doc) return;

    inFlight++;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getElasticsearchClient } = require('./es-client') as typeof import('./es-client');
      getElasticsearchClient()
        .index({ index: 'system_errors', document: doc })
        .catch(() => {
          /* intentionally swallowed — logging must never fail */
        })
        .finally(() => {
          inFlight--;
        });
    } catch {
      inFlight--;
    }
  },
};

streams.push({ level: 'error', stream: errorIndexStream });

// ── Root logger ───────────────────────────────────────────────────────────────
/**
 * Error serializer: JS Error objects have no enumerable own properties, so JSON.stringify(err)
 * yields "{}". Pino's built-in serializer fixes this for the reserved `err` key, but the
 * Temporal SDK passes errors under `error`. Register both.
 */
export const logger = pino(
  {
    level,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  },
  pino.multistream(streams),
);

/**
 * Create a child logger scoped to a component name.
 * Convention: `domain:component`, e.g. createLogger('cart:worker').
 */
export function createLogger(component: string) {
  return logger.child({ component });
}
