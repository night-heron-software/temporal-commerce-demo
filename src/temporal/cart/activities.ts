/**
 * Cart Activities
 * Activity proxies for workflow use
 */

import { proxyActivities } from '@temporalio/workflow';
import { Elasticsearch } from '../contracts';

export interface CartActivities {
  validateInventory(storeId: string, variantId: string, quantity: number): Promise<boolean>;
  reserveCartItem(storeId: string, cartId: string, variantId: string, quantity: number): Promise<string | null>;
  releaseCartItem(cartId: string, variantId: string): Promise<void>;
  indexCart(doc: Elasticsearch.CartDocument): Promise<void>;
  deleteCart(cartId: string): Promise<void>;
}

export const { validateInventory, reserveCartItem, releaseCartItem, indexCart, deleteCart } = proxyActivities<CartActivities>({
  startToCloseTimeout: '1m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2
  }
});
