/**
 * Elasticsearch index mappings for the commerce demo.
 * Subset of nightheron-infrastructure/es-index-mappings — only products and collections.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const INDEX_MAPPINGS: Record<string, any> = {
  products: {
    properties: {
      id: { type: 'keyword' },
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      description: { type: 'text' },
      type: { type: 'keyword' },
      price: {
        properties: {
          amount: { type: 'integer' },
          currency: { type: 'keyword' }
        }
      },
      collectionId: { type: 'keyword' },
      collectionName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      collectionNames: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      defaultVariantId: { type: 'keyword' },
      defaultVariantImageUrl: { type: 'keyword', index: false },
      variants: {
        type: 'nested',
        properties: {
          id: { type: 'keyword' },
          blankSku: { type: 'keyword' },
          price: {
            properties: {
              amount: { type: 'integer' },
              currency: { type: 'keyword' }
            }
          },
          available: { type: 'boolean' },
          frontImageUrl: { type: 'keyword', index: false },
          options: {
            type: 'nested',
            properties: {
              optionType: { type: 'keyword' },
              value: {
                properties: {
                  type: { type: 'keyword' },
                  name: { type: 'keyword' },
                  label: { type: 'keyword' },
                  hex: { type: 'keyword' }
                }
              }
            }
          }
        }
      },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' }
    }
  },
  collections: {
    properties: {
      id: { type: 'keyword' },
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      thumbnailUrl: { type: 'keyword', index: false },
      productCount: { type: 'integer' }
    }
  }
};

export async function ensureIndicesExist(): Promise<void> {
  const { getElasticsearchClient } = await import('./es-client');
  const client = getElasticsearchClient();

  for (const [indexName, mapping] of Object.entries(INDEX_MAPPINGS)) {
    const exists = await client.indices.exists({ index: indexName });
    if (!exists) {
      await client.indices.create({
        index: indexName,
        mappings: mapping
      });
      console.log(`[ES] Created index: ${indexName}`);
    } else {
      console.log(`[ES] Index already exists: ${indexName}`);
    }
  }
}
