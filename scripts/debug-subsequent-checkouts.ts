import { v4 as uuidv4 } from 'uuid';
import { getTemporalClient } from '../src/lib/temporal-client';
import { getCassandraClient, executeCql } from '../src/lib/cassandra-client';
import { Cart, Checkout, OMS, Constants } from '../src/temporal/contracts';
import { WithStartWorkflowOperation } from '@temporalio/client';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCheckout(variantId: string, runIndex: number) {
  console.log(`\n--- STARTING CHECKOUT RUN #${runIndex} ---`);
  const client = await getTemporalClient();
  const cartId = uuidv4();
  const cartWorkflowId = `cart-${cartId}`;

  console.log(`[Run ${runIndex}] Creating Cart & Adding Variant...`);
  const startOp = new WithStartWorkflowOperation('cartWorkflow', {
    workflowId: cartWorkflowId,
    args: [{ cartId }],
    taskQueue: Constants.CART_TASK_QUEUE,
    workflowIdConflictPolicy: 'USE_EXISTING',
    workflowExecutionTimeout: '30 days',
  });

  await client.workflow.executeUpdateWithStart(Cart.cartUpdate, {
    startWorkflowOperation: startOp,
    args: [{ type: 'addItem' as const, variantId, quantity: 1, price: 15.99 }]
  });
  console.log(`[Run ${runIndex}] Cart Created: ${cartId}. Item added.`);

  console.log(`[Run ${runIndex}] Starting Checkout...`);
  const cartHandle = client.workflow.getHandle(cartWorkflowId);
  await cartHandle.executeUpdate(Cart.cartUpdate, { args: [{ type: 'beginCheckout' as const }] });

  const checkoutWfId = await cartHandle.query(Cart.getCheckoutWorkflowIdQuery);
  if (!checkoutWfId) throw new Error('Checkout workflow did not spawn.');
  console.log(`[Run ${runIndex}] Checkout Workflow ID: ${checkoutWfId}`);

  const checkoutHandle = client.workflow.getHandle(checkoutWfId);

  // Poll until reservations confirm
  console.log(`[Run ${runIndex}] Waiting for inventory reservations...`);
  let isReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const state = await checkoutHandle.query(Checkout.getCheckoutStateQuery);
      if (state.step && state.step !== 'validating') {
        if (state.step === 'failed' || state.step === 'cancelled' || state.error) {
          throw new Error(`Checkout rejected: ${state.error}`);
        }
        isReady = true;
        break;
      }
    } catch (e: any) {
      if (e.name !== 'QueryNotRegisteredError') {
        throw e;
      }
    }
    await delay(1000);
  }
  if (!isReady) throw new Error("Checkout stalled in validating.");

  // Set Shipping details
  console.log(`[Run ${runIndex}] Setting Shipping Address...`);
  await checkoutHandle.executeUpdate(Checkout.setShippingUpdate, {
    args: [
      {
        shippingAddress: {
          firstName: 'Demo',
          lastName: 'User',
          address1: '123 Validation St',
          city: 'Testville',
          state: 'TX',
          postalCode: '78701',
          country: 'US',
          email: 'demo@nightheron.test'
        }
      }
    ]
  });

  // Apply mock payment
  console.log(`[Run ${runIndex}] Setting Payment Method...`);
  await checkoutHandle.executeUpdate(Checkout.setPaymentUpdate, {
    args: [{ paymentMethod: { type: 'mock' as const, token: 'valid' } }]
  });

  // Submit final order
  console.log(`[Run ${runIndex}] Submitting Order...`);
  await checkoutHandle.executeUpdate(Checkout.submitOrderUpdate, { args: [{}] });

  // Poll checkout status until complete
  console.log(`[Run ${runIndex}] Waiting for completion...`);
  let isComplete = false;
  let orderId = '';
  for (let i = 0; i < 30; i++) {
    const state = await checkoutHandle.query(Checkout.getCheckoutStateQuery);
    if (state.step === 'complete') {
      isComplete = true;
      orderId = state.order?.orderId || '';
      break;
    }
    await delay(1000);
  }
  if (!isComplete) throw new Error("Order submission did not complete.");
  console.log(`[Run ${runIndex}] Complete! Order ID: ${orderId}`);
}

async function run() {
  try {
    const variants = await executeCql<{ id: any }>('SELECT id FROM catalog.variants LIMIT 1');
    if (variants.length === 0) {
      throw new Error('No variants found in Cassandra catalog.');
    }
    const variantId = variants[0].id.toString();

    await runCheckout(variantId, 1);
    await runCheckout(variantId, 2);

    console.log('\n🎉 SUCCESS: Both checkouts completed without errors!');
    await getCassandraClient().shutdown();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Subsequent checkouts failed:', error);
    try {
      await getCassandraClient().shutdown();
    } catch (_) {}
    process.exit(1);
  }
}

run();
