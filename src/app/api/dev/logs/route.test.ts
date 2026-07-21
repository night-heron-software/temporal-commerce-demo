import fs from 'fs';
import path from 'path';
import os from 'os';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { querySystemLogs, getAvailableLogServices } from '@/app/dev/logs/logs-service';
import { GET } from './route';

describe('System Logs Query & API Route', () => {
  let tempDir: string;
  const originalLogDir = process.env.LOG_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-log-test-'));
    process.env.LOG_DIR = tempDir;

    const sampleWebLog = [
      JSON.stringify({
        level: 30,
        time: Date.now() - 5 * 60 * 1000,
        msg: 'Storefront page render ok',
        component: 'storefront',
        path: '/shop',
      }),
      JSON.stringify({
        level: 50,
        time: Date.now() - 2 * 60 * 1000,
        msg: 'Search failed to connect',
        component: 'api',
        err: 'Connection refused',
      }),
    ].join('\n');

    const sampleWorkersLog = [
      JSON.stringify({
        level: 40,
        time: Date.now() - 10 * 60 * 1000,
        msg: 'Inventory worker retrying connection',
        component: 'inventory-worker',
      }),
      JSON.stringify({
        level: 60,
        time: Date.now() - 1 * 60 * 1000,
        msg: 'Fatal worker process crash',
        component: 'oms-worker',
      }),
    ].join('\n');

    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(tempDir, `demo-web-${today}.log`), sampleWebLog);
    fs.writeFileSync(path.join(tempDir, `demo-workers-${today}.log`), sampleWorkersLog);
  });

  afterEach(() => {
    process.env.LOG_DIR = originalLogDir;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('discovers available log services from log filenames', () => {
    const services = getAvailableLogServices();
    expect(services).toEqual(['web', 'workers']);
  });

  it('queries all log hits across services sorted descending by time', async () => {
    const result = await querySystemLogs({ since: '1h' });
    expect(result.total).toBe(4);
    expect(result.hits[0].message).toBe('Fatal worker process crash');
    expect(result.hits[0].service).toBe('workers');
  });

  it('filters log hits by level', async () => {
    const errorHits = await querySystemLogs({ level: 'error' });
    expect(errorHits.total).toBe(2); // error (50) and fatal (60)
    expect(errorHits.hits.map((h) => h.level)).toContain('error');
    expect(errorHits.hits.map((h) => h.level)).toContain('fatal');

    const fatalOnly = await querySystemLogs({ level: 'fatal' });
    expect(fatalOnly.total).toBe(1);
    expect(fatalOnly.hits[0].message).toBe('Fatal worker process crash');
  });

  it('filters log hits by service', async () => {
    const webOnly = await querySystemLogs({ service: 'web' });
    expect(webOnly.total).toBe(2);
    expect(webOnly.hits.every((h) => h.service === 'web')).toBe(true);
  });

  it('filters log hits by search query q', async () => {
    const searchResult = await querySystemLogs({ q: 'retrying' });
    expect(searchResult.total).toBe(1);
    expect(searchResult.hits[0].message).toBe('Inventory worker retrying connection');
  });

  it('responds via the GET route handler', async () => {
    const req = new NextRequest('http://localhost:3000/api/dev/logs?service=web&level=error');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.hits[0].service).toBe('web');
    expect(body.hits[0].level).toBe('error');
  });
});
