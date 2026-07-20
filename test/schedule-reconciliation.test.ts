import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planScheduleReconciliation,
  type ScheduledDeliveryState,
  type ScheduleTarget,
} from '../src/scheduling/domain/schedule-reconciliation.js';

const target = (overrides: Partial<ScheduleTarget> = {}): ScheduleTarget => ({
  subscriptionId: 'subscription',
  revisionId: 'revision-1',
  householdId: 'household',
  productId: 'product',
  unitId: 'unit',
  deliverySlotId: 'slot-1',
  plannedQuantity: '1.250',
  ...overrides,
});
const existing = (overrides: Partial<ScheduledDeliveryState> = {}): ScheduledDeliveryState => ({
  id: 'delivery-1',
  ...target(),
  status: 'scheduled',
  version: 1,
  finalized: false,
  ...overrides,
});

void test('reconciliation creates, preserves, updates, reactivates, and cancels disjoint rows', () => {
  assert.deepEqual(planScheduleReconciliation([], [target()]).created, [target()]);
  assert.deepEqual(planScheduleReconciliation([existing()], [target()]).existing.map(({ id }) => id), ['delivery-1']);
  assert.deepEqual(planScheduleReconciliation([existing()], [target({ revisionId: 'revision-2' })]).updated.map(({ id }) => id), ['delivery-1']);
  assert.deepEqual(planScheduleReconciliation([existing({ status: 'cancelled' })], [target()]).updated.map(({ id }) => id), ['delivery-1']);
  assert.deepEqual(planScheduleReconciliation([existing()], []).cancelled.map(({ id }) => id), ['delivery-1']);
});

void test('slot changes cancel old rows and create new rows while finalized subscriptions remain immutable', () => {
  const changed = planScheduleReconciliation([existing()], [target({ deliverySlotId: 'slot-2' })]);
  assert.deepEqual(changed.created.map(({ deliverySlotId }) => deliverySlotId), ['slot-2']);
  assert.deepEqual(changed.cancelled.map(({ deliverySlotId }) => deliverySlotId), ['slot-1']);

  const finalized = planScheduleReconciliation([existing({ finalized: true })], [target({ deliverySlotId: 'slot-2' })]);
  assert.deepEqual(finalized.created, []);
  assert.deepEqual(finalized.updated, []);
  assert.deepEqual(finalized.cancelled, []);
  assert.deepEqual(finalized.existing.map(({ id }) => id), ['delivery-1']);
});
