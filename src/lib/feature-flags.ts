/**
 * Feature Flags Store
 * Simple file-backed feature flag storage for the demo.
 * Both the Next.js app and Temporal workers read/write the same file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const FLAGS_DIR = join(process.cwd(), '.data');
const FLAGS_FILE = join(FLAGS_DIR, 'feature-flags.json');

interface FeatureFlags {
  [key: string]: boolean;
}

const DEFAULTS: FeatureFlags = {
  MANUAL_FULFILLMENT: false,
  DATA_FLOW_LOGGING: false,
};

function ensureDir(): void {
  if (!existsSync(FLAGS_DIR)) {
    mkdirSync(FLAGS_DIR, { recursive: true });
  }
}

function readFlags(): FeatureFlags {
  ensureDir();
  if (!existsSync(FLAGS_FILE)) {
    writeFileSync(FLAGS_FILE, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }
  try {
    return JSON.parse(readFileSync(FLAGS_FILE, 'utf-8'));
  } catch {
    return { ...DEFAULTS };
  }
}

function writeFlags(flags: FeatureFlags): void {
  ensureDir();
  writeFileSync(FLAGS_FILE, JSON.stringify(flags, null, 2));
}

export function getFlag(name: string): boolean {
  const flags = readFlags();
  return flags[name] ?? DEFAULTS[name] ?? false;
}

export function setFlag(name: string, value: boolean): void {
  const flags = readFlags();
  flags[name] = value;
  writeFlags(flags);
}

export function getAllFlags(): FeatureFlags {
  return readFlags();
}
