/**
 * Rotation tests for the file sink (the parent platform's mono-issue-0320).
 *
 * Kept out of any filesystem-free logger test deliberately: these must touch the filesystem —
 * the defect was that a *file* was never reopened, so a test that mocked the filesystem away
 * could not have seen it.
 *
 * The clock is injected rather than faked globally, because the bug is about what happens when
 * real wall-clock time crosses a UTC midnight while a process keeps running.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createLazyFileStream } from './logger';

let dir: string;
let prevLogDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-log-rot-'));
  prevLogDir = process.env.LOG_DIR;
  process.env.LOG_DIR = dir;
});

afterEach(() => {
  if (prevLogDir === undefined) delete process.env.LOG_DIR;
  else process.env.LOG_DIR = prevLogDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (iso: string) => Date.parse(iso);
const files = () =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .sort();

/**
 * `fs.createWriteStream` both opens AND writes asynchronously, so neither the file nor its
 * contents are on disk the instant `.write()` returns. Poll the actual condition rather than a
 * proxy for it — a fixed sleep is either flaky or slow.
 */
async function waitFor(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const read = (name: string): string => {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return '';
  }
};

describe('createLazyFileStream — rotation', () => {
  it('opens nothing until the first write', async () => {
    createLazyFileStream('workers', () => at('2026-08-22T23:47:00Z'));
    await new Promise((r) => setTimeout(r, 20));
    // The laziness is load-bearing: `next build` reaches this module through api-utils and
    // would otherwise create logs/ as a side effect of merely evaluating it.
    expect(files()).toEqual([]);
  });

  it('writes the next day into a NEW file — the mono-issue-0320 defect', async () => {
    let now = at('2026-08-22T23:47:00Z');
    const s = createLazyFileStream('workers', () => now);

    s.write('before midnight\n');
    await waitFor(
      () => read('demo-workers-2026-08-22.log').includes('before midnight'),
      'day 1 line',
    );
    expect(files()).toEqual(['demo-workers-2026-08-22.log']);

    // Same process, same stream object, clock crosses UTC midnight.
    now = at('2026-08-23T14:01:00Z');
    s.write('after midnight\n');
    await waitFor(() => read('demo-workers-2026-08-23.log').includes('after midnight'), 'day 2');

    expect(files()).toEqual(['demo-workers-2026-08-22.log', 'demo-workers-2026-08-23.log']);
    // The line landed in the file named for the day it was written — an auditor globbing
    // today's date must find today's lines.
    expect(read('demo-workers-2026-08-23.log')).toContain('after midnight');
    expect(read('demo-workers-2026-08-22.log')).not.toContain('after midnight');
  });

  it('does NOT reopen within the same UTC day — the control', async () => {
    // Without this, a fix that reopened on every write would pass the test above while
    // thrashing the filesystem on the hot path.
    let now = at('2026-08-23T00:00:01Z');
    const s = createLazyFileStream('workers', () => now);
    s.write('a\n');
    now = at('2026-08-23T23:59:59Z');
    s.write('b\n');
    await waitFor(() => read('demo-workers-2026-08-23.log').includes('b'), 'same-day line');

    expect(files()).toEqual(['demo-workers-2026-08-23.log']);
    expect(read('demo-workers-2026-08-23.log')).toContain('a');
  });

  it('rolls across a multi-day gap, not just one boundary', async () => {
    // A worker idle over a weekend must not resurrect Friday's filename on Monday.
    let now = at('2026-08-21T12:00:00Z');
    const s = createLazyFileStream('workers', () => now);
    s.write('fri\n');
    now = at('2026-08-24T12:00:00Z');
    s.write('mon\n');
    await waitFor(() => read('demo-workers-2026-08-24.log').includes('mon'), 'monday line');

    expect(files()).toEqual(['demo-workers-2026-08-21.log', 'demo-workers-2026-08-24.log']);
  });
});
