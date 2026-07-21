/**
 * System logs service.
 *
 * Reads machine-readable JSON log files written by `src/lib/logger.ts` under `LOG_DIR`
 * (e.g. `logs/demo-web-2026-07-21.log`, `logs/demo-workers-2026-07-21.log`).
 * Server-only — imported by the API route, never a client bundle.
 */

import fs from 'fs';
import path from 'path';

export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const PINO_LEVEL_MAP: Record<number, LogLevelName> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export const LEVEL_NAME_TO_MIN_NUM: Record<LogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LogHit {
  id: string;
  timestamp: string;
  level: LogLevelName;
  levelNum: number;
  message: string;
  service: string;
  component?: string;
  taskQueue?: string;
  workflowType?: string;
  activityType?: string;
  context: Record<string, unknown>;
}

export interface SystemLogsResponse {
  hits: LogHit[];
  total: number;
  page: number;
  pageSize: number;
  availableServices: string[];
}

export const SINCE_OFFSETS: Record<string, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_SINCE = '24h';
export const DEFAULT_PAGE_SIZE = 50;

export interface LogQueryParams {
  service?: string;
  level?: LogLevelName | 'all';
  since?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

function getLogDir(): string {
  return path.resolve(process.cwd(), process.env.LOG_DIR || 'logs');
}

/** Extract service tag from log file name (e.g. `demo-web-2026-07-21.log` => `web`) */
function parseServiceFromFilename(filename: string): string {
  const match = /^demo-([a-zA-Z0-9_-]+)-\d{4}-\d{2}-\d{2}\.log$/.exec(filename);
  return match ? match[1] : 'app';
}

/** Get list of distinct service names available in existing log files */
export function getAvailableLogServices(): string[] {
  const logDir = getLogDir();
  if (!fs.existsSync(logDir)) return [];
  try {
    const files = fs.readdirSync(logDir);
    const services = new Set<string>();
    for (const file of files) {
      if (file.startsWith('demo-') && file.endsWith('.log')) {
        services.add(parseServiceFromFilename(file));
      }
    }
    return Array.from(services).sort();
  } catch {
    return [];
  }
}

/** Query and filter log lines across log files */
export async function querySystemLogs(params: LogQueryParams = {}): Promise<SystemLogsResponse> {
  const logDir = getLogDir();
  const availableServices = getAvailableLogServices();

  const service = params.service && params.service !== 'all' ? params.service : undefined;
  const levelFilter = params.level && params.level !== 'all' ? params.level : undefined;
  const minLevelNum = levelFilter ? LEVEL_NAME_TO_MIN_NUM[levelFilter] : 0;

  const sinceKey = params.since && params.since in SINCE_OFFSETS ? params.since : DEFAULT_SINCE;
  const minTimestamp = Date.now() - SINCE_OFFSETS[sinceKey];

  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, params.pageSize ?? DEFAULT_PAGE_SIZE));
  const queryText = params.q?.trim().toLowerCase();

  const hits: LogHit[] = [];

  if (fs.existsSync(logDir)) {
    try {
      const files = fs.readdirSync(logDir);
      for (const file of files) {
        if (!file.startsWith('demo-') || !file.endsWith('.log')) continue;
        const fileService = parseServiceFromFilename(file);
        if (service && fileService !== service) continue;

        const filePath = path.join(logDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        let lineIdx = 0;
        for (const line of lines) {
          lineIdx++;
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line);
            const levelNum = typeof raw.level === 'number' ? raw.level : 30;
            if (minLevelNum > 0 && levelNum < minLevelNum) continue;

            const timeMs = typeof raw.time === 'number' ? raw.time : Date.parse(raw.timestamp || 0);
            if (Number.isNaN(timeMs) || timeMs < minTimestamp) continue;

            const msg = raw.msg || raw.message || '';
            const component = raw.component || raw.name || undefined;
            const taskQueue = typeof raw.taskQueue === 'string' ? raw.taskQueue : undefined;
            const workflowType = typeof raw.workflowType === 'string' ? raw.workflowType : undefined;
            const activityType = typeof raw.activityType === 'string' ? raw.activityType : undefined;

            // Free text matching
            if (queryText) {
              const fullString = JSON.stringify(raw).toLowerCase();
              if (!fullString.includes(queryText)) continue;
            }

            const { level: _l, time: _t, msg: _m, message: _msg, ...context } = raw;

            hits.push({
              id: `${file}-${lineIdx}-${timeMs}`,
              timestamp: new Date(timeMs).toISOString(),
              level: PINO_LEVEL_MAP[levelNum] || 'info',
              levelNum,
              message: msg,
              service: fileService,
              component,
              taskQueue,
              workflowType,
              activityType,
              context,
            });
          } catch {
            // Skip unparseable log lines
          }
        }
      }
    } catch {
      // Best effort file reading
    }
  }

  // Sort descending by timestamp
  hits.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const total = hits.length;
  const paginatedHits = hits.slice((page - 1) * pageSize, page * pageSize);

  return {
    hits: paginatedHits,
    total,
    page,
    pageSize,
    availableServices,
  };
}
