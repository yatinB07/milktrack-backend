import assert from 'node:assert/strict';
import test from 'node:test';

import { type TransactionContext } from '../src/common/application/transaction-context.js';
import { DefaultDeliveryLeaveProjection } from '../src/delivery/application/delivery-leave.projection.js';
import {
  DeliveryStore,
  type DeliveryOccurrenceKey,
} from '../src/delivery/application/delivery.store.js';

const key: DeliveryOccurrenceKey = {
  vendorId: 'vendor',
  subscriptionId: 'subscription',
  serviceDate: '2030-01-01',
  deliverySlotId: 'slot',
};

void test('leave projection delegates apply and reversal through the caller transaction', async () => {
  const calls: unknown[][] = [];
  const store = {
    applyCustomerLeave: (...input: unknown[]) => { calls.push(input); return Promise.resolve(); },
    reverseCustomerLeave: (...input: unknown[]) => { calls.push(input); return Promise.resolve(); },
  } as DeliveryStore;
  const projection = new DefaultDeliveryLeaveProjection(store);
  const transaction = {} as TransactionContext;

  await projection.applyCustomerLeave(transaction, key, 'actor', 'vendor_admin');
  await projection.reverseCustomerLeave(transaction, key, 'actor', 'vendor_admin');

  assert.deepEqual(calls, [
    [transaction, key, 'actor', 'vendor_admin'],
    [transaction, key, 'actor', 'vendor_admin'],
  ]);
});
