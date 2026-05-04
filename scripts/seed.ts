/**
 * Seed Script — Orchestrates all seeding via API calls to the running app.
 *
 * Usage:
 *   npx tsx scripts/seed.ts
 *
 * Prerequisites: `make dev` (infrastructure) and `npm run dev` (Next.js)
 */

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

async function call(
  label: string,
  method: 'GET' | 'POST',
  path: string,
  body?: object
): Promise<unknown> {
  console.log(`\n--- ${label} ---`);
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${label} failed: ${res.status} ${res.statusText} — ${text}`);
  }

  const result = await res.json();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function seed() {
  console.log(`Starting seeding pipeline via API at ${BASE_URL}...`);
  console.log('(Next.js dev server must be running.)\n');

  // 1. Ensure ES indices exist
  await call('ES Index Init', 'POST', '/api/dev/init/es-indices');

  // 2. Seed catalog (products, variants, collections) → Cassandra
  await call('Seed Catalog', 'POST', '/api/seed-cassandra');

  // 3. Reindex catalog to ES
  await call('Reindex Collections', 'POST', '/api/dev/reindex', { index: 'collections' });
  await call('Reindex Products', 'POST', '/api/dev/reindex', { index: 'products' });

  console.log('\n✨ Seeding complete!');
  console.log('   Storefront → http://localhost:3000/shop');
  console.log('   Temporal UI → http://localhost:8233');

  process.exit(0);
}

seed().catch((err) => {
  console.error('\n❌ Seeding failed:', err);
  process.exit(1);
});
