/**
 * System Validation Script
 *
 * Validates that all demo services are running and configured correctly.
 * Adapted from nightheron-mono/tools/src/ops/validate-system.ts.
 * Auth-specific checks removed (the demo has no authentication).
 *
 * Usage:
 *   npm run dev:validate
 *   tsx --env-file=.env.local scripts/validate-system.ts [--json] [--skip-es] [--skip-api]
 */

const JSON_MODE = process.argv.includes('--json');

const checks: { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; message?: string; details?: unknown }[] = [];

async function recordCheck(name: string, fn: () => Promise<unknown>, skip = false) {
  if (skip) {
    checks.push({ name, status: 'SKIP', message: 'Skipped via flag' });
    if (!JSON_MODE) console.log(`[SKIP] ${name}`);
    return;
  }
  try {
    const details = await fn();
    checks.push({ name, status: 'PASS', details });
    if (!JSON_MODE) console.log(`[PASS] ${name}`);
  } catch (error) {
    checks.push({ name, status: 'FAIL', message: String(error) });
    if (!JSON_MODE) console.error(`[FAIL] ${name}: ${error}`);
  }
}

async function run() {
  const skipES = process.argv.includes('--skip-es');
  const skipApi = process.argv.includes('--skip-api');

  if (!JSON_MODE) console.log('Starting System Validation...\n');

  // 1. Environment configuration
  await recordCheck('Environment Configuration', async () => {
    const required = ['TEMPORAL_ADDRESS', 'CASSANDRA_CONTACT_POINTS', 'ELASTICSEARCH_URL'];
    const missing = required.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    }
    return { verified: required };
  });

  // 2. API Health (deep check)
  await recordCheck('API Health (deep)', async () => {
    const res = await fetch('http://localhost:3000/api/health');
    if (!res.ok && res.status !== 503) throw new Error(`Health API returned ${res.status}`);
    const data = (await res.json()) as { status: string; services?: unknown };
    if (data.status === 'unhealthy') throw new Error(`Health API reports: ${data.status}`);
    return data;
  }, skipApi);

  // 3. Search API endpoint
  await recordCheck('Search API Endpoint', async () => {
    const res = await fetch('http://localhost:3000/api/search?q=*');
    if (!res.ok && res.status !== 404) throw new Error(`Search API returned ${res.status}`);
    return { status: res.status };
  }, skipApi);

  // 4. Elasticsearch cluster health
  await recordCheck('Elasticsearch Cluster Health', async () => {
    const res = await fetch('http://localhost:9200/_cluster/health');
    if (!res.ok) throw new Error(`ES Cluster Health returned ${res.status}`);
    const data = (await res.json()) as { status: string };
    if (data.status === 'red') throw new Error('Cluster status is RED');
    return data;
  }, skipES);

  // 5. Elasticsearch index mapping consistency
  await recordCheck('Elasticsearch Index Mapping', async () => {
    const res = await fetch('http://localhost:9200/_mapping');
    if (!res.ok) throw new Error(`ES Mapping lookup returned ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (!data.products) throw new Error('Products index is missing');
    return { detectedIndices: Object.keys(data) };
  }, skipES);

  // 6. Seed data verification
  await recordCheck('Seed Data — Products in Elasticsearch', async () => {
    const res = await fetch('http://localhost:9200/products/_count');
    if (!res.ok) throw new Error(`ES product count returned ${res.status}`);
    const data = (await res.json()) as { count: number };
    if (data.count === 0) throw new Error('Products index is empty — run npm run dev:seed');
    return { productCount: data.count };
  }, skipES);

  if (JSON_MODE) {
    console.log(JSON.stringify({ checks, timestamp: new Date().toISOString() }, null, 2));
  } else {
    console.log('\n--- Validation Summary ---');
    const failures = checks.filter((c) => c.status === 'FAIL');
    console.log(`Passed:  ${checks.filter((c) => c.status === 'PASS').length}`);
    console.log(`Failed:  ${failures.length}`);
    console.log(`Skipped: ${checks.filter((c) => c.status === 'SKIP').length}`);

    if (failures.length > 0) {
      console.error('\nFailures:');
      failures.forEach((f) => console.error(`  ✗ ${f.name}: ${f.message}`));
      process.exit(1);
    } else {
      console.log('\n✅ All Validation Checks Passed!');
    }
  }
}

run().catch((err) => {
  console.error('Fatal exception during validation:', err);
  process.exit(1);
});
