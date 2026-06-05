import { getElasticsearchClient } from './src/lib/es-client';

async function run() {
  const es = getElasticsearchClient();
  const res = await es.search({ index: 'carts' });
  console.log(JSON.stringify(res.hits.hits.map((h: any) => h._source), null, 2));
}

run().catch(console.error);
