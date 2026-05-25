import { v4 as uuidv4 } from 'uuid';
import { getTemporalClient } from '../src/lib/temporal-client';
import { getCassandraClient, executeCql } from '../src/lib/cassandra-client';
import { Cart, Checkout, OMS, Constants } from '../src/temporal/contracts';
import { WithStartWorkflowOperation } from '@temporalio/client';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  console.log('🛍️ Starting E2E Verification Check...\n');

  try {
    // 1. Fetch variant from Cassandra
    const variants = await executeCql<{ id: any }>(
      'SELECT id FROM catalog.variants LIMIT 1'
    );
    if (variants.length === 0) {
      throw new Error('No variants found in Cassandra catalog. Make sure the seed script ran successfully.');
    }
    const variantId = variants[0].id.toString();
    console.log(`✅ Selected Product Variant ID: ${variantId}\n`);

    // 2. Connect to Temporal
    const client = await getTemporalClient();
    const cartId = uuidv4();
    const cartWorkflowId = `cart-${cartId}`;

    console.log(`[1] Creating Cart & Adding Variant...`);
    const startOp = new WithStartWorkflowOperation('cartWorkflow', {
      workflowId: cartWorkflowId,
      args: [{ cartId }],
      taskQueue: Constants.CART_TASK_QUEUE,
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowExecutionTimeout: '30 days',
    });

    await client.workflow.executeUpdateWithStart(Cart.cartUpdate, {
      startWorkflowOperation: startOp,
      args: [{ type: 'addItem' as const, variantId, quantity: 2, price: 15.99 }]
    });
    console.log(`✅ Cart Created: ${cartId}. Item added!\n`);

    // 3. Initiate Checkout
    console.log(`[2] Starting Checkout...`);
    const cartHandle = client.workflow.getHandle(cartWorkflowId);
    await cartHandle.executeUpdate(Cart.cartUpdate, { args: [{ type: 'beginCheckout' as const }] });

    const checkoutWfId = await cartHandle.query(Cart.getCheckoutWorkflowIdQuery);
    if (!checkoutWfId) throw new Error('Checkout workflow did not spawn.');
    console.log(`✅ Checkout Workflow ID: ${checkoutWfId}\n`);

    const checkoutHandle = client.workflow.getHandle(checkoutWfId);

    // Poll until reservations confirm and child workflow enters 'shipping' phase
    console.log(`   🔸 Waiting for inventory reservations...`);
    let isReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const state = await checkoutHandle.query(Checkout.getCheckoutStateQuery);
        if (state.step && state.step !== 'validating') {
          if (state.step === 'failed' || state.step === 'cancelled' || state.error) {
            throw new Error(`Checkout rejected during validation: ${state.error}`);
          }
          isReady = true;
          break;
        }
      } catch (e: any) {
        if (e.name === 'QueryNotRegisteredError') {
          // Normal during boot
        } else if (e.name === 'WorkflowExecutionAlreadyCompletedError') {
          throw new Error(`Checkout workflow terminated unexpectedly.`);
        } else {
          throw e;
        }
      }
      await delay(1000);
    }
    if (!isReady) throw new Error("Checkout workflow stalled in validating state.");
    console.log(`✅ Inventory reservations complete!\n`);

    // 4. Set Shipping details
    console.log(`   🔸 Setting Shipping Address...`);
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
    console.log(`✅ Shipping address set!\n`);

    // 5. Apply mock payment
    console.log(`   🔸 Setting Payment Method...`);
    await checkoutHandle.executeUpdate(Checkout.setPaymentUpdate, {
      args: [{ paymentMethod: { type: 'mock' as const, token: 'valid' } }]
    });
    console.log(`✅ Mock payment method set!\n`);

    // 6. Submit final order
    console.log(`   🔸 Submitting Order...`);
    await checkoutHandle.executeUpdate(Checkout.submitOrderUpdate, { args: [{}] });

    // Poll checkout status until complete
    console.log(`   🔸 Waiting for order completion...`);
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
    console.log(`✅ Order Submitted successfully! Order ID: ${orderId}\n`);

    // 7. Track OMS & Fulfillment Workflow
    console.log(`[3] Tracking Fulfillment via Temporal...`);
    const omsWorkflowId = `order-${orderId}`;
    const omsHandle = client.workflow.getHandle(omsWorkflowId);

    // Poll OMS status
    let supplierOrderId = '';
    for (let i = 0; i < 30; i++) {
      try {
        const omsState = await omsHandle.query(OMS.getOrderStateQuery);
        if (omsState.supplierOrders && omsState.supplierOrders.length > 0) {
          supplierOrderId = omsState.supplierOrders[0].supplierOrderId;
          break;
        }
      } catch (e) {
        // Query may fail if workflow is not fully initialized yet
      }
      await delay(1000);
    }
    if (!supplierOrderId) {
      throw new Error(`OMS workflow did not generate supplier order in time.`);
    }
    console.log(`✅ Found Supplier Order ID: ${supplierOrderId}\n`);

    const fulfillmentWorkflowId = `fulfillment-${orderId}`;
    const fulfillmentHandle = client.workflow.getHandle(fulfillmentWorkflowId);

    console.log(`   🔸 Monitoring fulfillment progress...`);
    let fulfillmentStatus = '';
    for (let i = 0; i < 60; i++) {
      try {
        const fullState: any = await fulfillmentHandle.query('getStatus');
        fulfillmentStatus = fullState.status;
        console.log(`      Current fulfillment status: ${fulfillmentStatus}`);
        if (fulfillmentStatus === 'shipped' || fulfillmentStatus === 'delivered') {
          break;
        }
      } catch (e) {
        // Ignore
      }
      await delay(1500);
    }

    if (fulfillmentStatus !== 'shipped' && fulfillmentStatus !== 'delivered') {
      throw new Error(`Fulfillment did not progress as expected. Last status: ${fulfillmentStatus}`);
    }

    console.log(`\n🎉 E2E Verification Check Completed Successfully with ZERO Errors!`);
    await getCassandraClient().shutdown();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ E2E Verification failed:', error);
    try {
      await getCassandraClient().shutdown();
    } catch (_) {}
    process.exit(1);
  }
}

run();
