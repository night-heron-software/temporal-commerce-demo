/**
 * Elasticsearch index mappings for the commerce demo.
 * All domain objects — products, orders, inventory, fulfillments, etc.
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
  },
  orders: {
    properties: {
      orderId: { type: 'keyword' },
      cartId: { type: 'keyword' },
      confirmationNumber: { type: 'keyword' },
      customerEmail: { type: 'keyword' },
      customerName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      status: { type: 'keyword' },
      subtotal: { type: 'integer' },
      shippingCost: { type: 'integer' },
      tax: { type: 'integer' },
      totalDiscounts: { type: 'integer' },
      total: { type: 'integer' },
      currency: { type: 'keyword' },
      shippingAddress: {
        properties: {
          firstName: { type: 'text' },
          lastName: { type: 'text' },
          address1: { type: 'text' },
          address2: { type: 'text' },
          city: { type: 'keyword' },
          state: { type: 'keyword' },
          postalCode: { type: 'keyword' },
          country: { type: 'keyword' },
          phone: { type: 'keyword' },
          email: { type: 'keyword' }
        }
      },
      paymentMethod: {
        properties: {
          type: { type: 'keyword' },
          last4: { type: 'keyword' }
        }
      },
      items: {
        type: 'nested',
        properties: {
          lineItemId: { type: 'keyword' },
          variantId: { type: 'keyword' },
          quantity: { type: 'integer' },
          price: { type: 'integer' }
        }
      },
      itemCount: { type: 'integer' },
      variantIds: { type: 'keyword' },
      assignments: {
        type: 'nested',
        properties: {
          assignmentId: { type: 'keyword' },
          lineItemId: { type: 'keyword' },
          variantId: { type: 'keyword' },
          supplierId: { type: 'keyword' },
          supplierName: { type: 'keyword' },
          quantity: { type: 'integer' },
          status: { type: 'keyword' },
          supplierOrderId: { type: 'keyword' },
          carrier: { type: 'keyword' }
        }
      },
      supplierOrders: {
        type: 'nested',
        properties: {
          supplierOrderId: { type: 'keyword' },
          supplierId: { type: 'keyword' },
          supplierName: { type: 'keyword' },
          status: { type: 'keyword' },
          itemCount: { type: 'integer' },
          carrier: { type: 'keyword' },
          trackingNumber: { type: 'keyword' },
          rejectionReason: { type: 'text' },
          createdAt: { type: 'date' },
          updatedAt: { type: 'date' }
        }
      },
      statusHistory: {
        type: 'nested',
        properties: {
          status: { type: 'keyword' },
          timestamp: { type: 'date' },
          note: { type: 'text' },
          updatedBy: { type: 'keyword' }
        }
      },
      deliveredAt: { type: 'date' },
      customerFeedback: {
        properties: {
          rating: { type: 'integer' },
          comment: { type: 'text' },
          submittedAt: { type: 'date' }
        }
      },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' }
    }
  },
  customers: {
    properties: {
      email: { type: 'keyword' },
      firstName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      lastName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      phone: { type: 'keyword' },
      totalSpent: { type: 'integer' },
      orderCount: { type: 'integer' },
      lastOrderAt: { type: 'date' }
    }
  },
  suppliers: {
    properties: {
      supplierId: { type: 'keyword' },
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      locations: {
        type: 'nested',
        properties: {
          locationId: { type: 'keyword' },
          name: { type: 'text' },
          cost: { type: 'integer' },
          address1: { type: 'text' },
          address2: { type: 'text' },
          city: { type: 'keyword' },
          state: { type: 'keyword' },
          postalCode: { type: 'keyword' },
          country: { type: 'keyword' },
          isPrimary: { type: 'boolean' }
        }
      }
    }
  },
  inventory: {
    properties: {
      variantId: { type: 'keyword' },
      totalStock: { type: 'integer' },
      reservedStock: { type: 'integer' },
      availableStock: { type: 'integer' },
      supplierCount: { type: 'integer' },
      supplierLocations: {
        type: 'nested',
        properties: {
          supplierId: { type: 'keyword' },
          supplierName: { type: 'keyword' },
          totalStock: { type: 'integer' },
          reservedStock: { type: 'integer' },
          orderedStock: { type: 'integer' },
          city: { type: 'keyword' },
          state: { type: 'keyword' },
          country: { type: 'keyword' },
          reservations: {
            type: 'nested',
            properties: {
              reservationId: { type: 'keyword' },
              cartId: { type: 'keyword' },
              quantity: { type: 'integer' },
              status: { type: 'keyword' },
              createdAt: { type: 'long' },
              expiresAt: { type: 'long' }
            }
          }
        }
      },
      reservations: {
        type: 'nested',
        properties: {
          reservationId: { type: 'keyword' },
          cartId: { type: 'keyword' },
          quantity: { type: 'integer' },
          status: { type: 'keyword' },
          createdAt: { type: 'long' },
          expiresAt: { type: 'long' }
        }
      },
      reservationIds: { type: 'keyword' },
      cartIds: { type: 'keyword' }
    }
  },
  supplier_orders: {
    properties: {
      supplierOrderId: { type: 'keyword' },
      orderId: { type: 'keyword' },
      supplierId: { type: 'keyword' },
      supplierName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      status: { type: 'keyword' },
      items: {
        type: 'nested',
        properties: {
          assignmentId: { type: 'keyword' },
          variantId: { type: 'keyword' },
          quantity: { type: 'integer' }
        }
      },
      itemCount: { type: 'integer' },
      carrier: { type: 'keyword' },
      trackingNumber: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      rejectionReason: { type: 'text' },
      statusHistory: {
        type: 'nested',
        properties: {
          status: { type: 'keyword' },
          timestamp: { type: 'date' },
          note: { type: 'text' }
        }
      }
    }
  },
  carts: {
    properties: {
      cartId: { type: 'keyword' },
      items: {
        type: 'nested',
        properties: {
          lineItemId: { type: 'keyword' },
          variantId: { type: 'keyword' },
          quantity: { type: 'integer' },
          price: { type: 'integer' }
        }
      },
      itemCount: { type: 'integer' },
      subtotalPrice: { type: 'integer' },
      totalPrice: { type: 'integer' },
      currency: { type: 'keyword' },
      status: { type: 'keyword' },
      appliedCoupons: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' }
    }
  },
  reservations: {
    properties: {
      reservationId: { type: 'keyword' },
      cartId: { type: 'keyword' },
      variantId: { type: 'keyword' },
      quantity: { type: 'integer' },
      status: { type: 'keyword' },
      expiresAt: { type: 'date' },
      createdAt: { type: 'date' }
    }
  },
  fulfillments: {
    properties: {
      orderId: { type: 'keyword' },
      customerId: { type: 'keyword' },
      status: { type: 'keyword' },
      supplierOrderCount: { type: 'integer' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      completedAt: { type: 'date' },
      errorMessage: { type: 'text' }
    }
  },
  shipments: {
    properties: {
      shipmentId: { type: 'keyword' },
      orderId: { type: 'keyword' },
      carrier: { type: 'keyword' },
      trackingNumber: { type: 'keyword' },
      trackingUrl: { type: 'keyword', index: false },
      itemCount: { type: 'integer' },
      shippedAt: { type: 'date' },
      deliveredAt: { type: 'date' }
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
