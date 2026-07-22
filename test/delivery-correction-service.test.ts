import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { TenantAuthorizationExecutor } from '../src/authorization/application/tenant-authorization.executor.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { DefaultDeliveryCorrectionService } from '../src/delivery/application/delivery-correction.service.js';
import type { DeliveryDetail, DeliveryStore } from '../src/delivery/application/delivery.store.js';

const vendorId = randomUUID();
const deliveryId = randomUUID();
const customerId = randomUUID();
const admin: Actor = {
  userId: randomUUID(), sessionId: randomUUID(), displayName: 'Admin', authenticationMethod: 'administrator_mfa', platformRoles: [],
  memberships: [{ id: randomUUID(), vendorId, vendorName: 'Milk', role: 'vendor_administrator', status: 'active' }],
};

const initial: DeliveryDetail = {
  id: deliveryId, vendorId, subscriptionId: randomUUID(), householdId: randomUUID(), productId: randomUUID(), unitId: randomUUID(),
  deliverySlotId: randomUUID(), serviceDate: '2030-01-01', plannedQuantity: '1', currentStatus: 'skipped_by_customer', version: 2,
  finalizedAt: new Date('2030-01-01T06:00:00.000Z'), customerUserIds: [customerId],
  events: [{ id: randomUUID(), eventType: 'skipped_by_customer', source: 'customer', actorUserId: customerId, occurredAt: new Date(), receivedAt: new Date(), createdAt: new Date() }],
};

void test('correction creates a price snapshot at original service time, preserves history, audits, and notifies the customer', async () => {
  const tx = {} as TransactionContext;
  let detail = initial; const snapshots: unknown[] = []; const corrections: unknown[] = []; const audits: unknown[] = []; const notifications: unknown[] = [];
  const authorization: Pick<TenantAuthorizationExecutor, 'execute'> = { execute: <T>(input: unknown, work: (current: TransactionContext) => Promise<T>): Promise<T> => { assert.deepEqual(input, { actor: admin, vendorId, permission: 'schedule:manage', operation: 'schedule.manual-generate' }); return work(tx); } };
  const deliveries = {
    lockCorrection: () => Promise.resolve(detail),
    getVendorDetail: () => Promise.resolve(detail),
    createPriceSnapshot: (_tx: TransactionContext, input: unknown) => { snapshots.push(input); return Promise.resolve(); },
    appendCorrection: (_tx: TransactionContext, input: { replacementOutcome: 'delivered'; actualQuantity: string }) => {
      corrections.push(input); detail = { ...detail, currentStatus: 'delivered', actualQuantity: input.actualQuantity, version: 3, snapshot: { amountMinor: '95', currency: 'INR', pricingLevel: 'global', sourcePriceId: randomUUID(), sourcePriceType: 'global_price', resolvedAt: new Date('2030-01-01T00:30:00.000Z') }, events: [...detail.events, { id: randomUUID(), eventType: 'delivered', source: 'vendor_admin', actorUserId: admin.userId, occurredAt: new Date(), receivedAt: new Date(), createdAt: new Date(), actualQuantity: input.actualQuantity, replacedEventId: initial.events[0].id }] };
      return Promise.resolve(detail);
    },
  };
  const prices = { resolve: () => Promise.resolve({ amountMinor: '95', currency: 'INR', pricingLevel: 'global' as const, sourcePriceId: randomUUID(), sourcePriceType: 'global_price' as const, resolvedAt: new Date('2030-01-01T00:30:00.000Z') }) };
  const service = new DefaultDeliveryCorrectionService(authorization, deliveries as unknown as DeliveryStore, prices, { append: (_tx: TransactionContext, event: unknown) => { audits.push(event); return Promise.resolve(); } }, { append: (_tx: TransactionContext, event: unknown) => { notifications.push(event); return Promise.resolve(); } });

  const result = await requestContextStore.run({ correlationId: randomUUID() }, () => service.correct(admin, vendorId, deliveryId, { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1.5', reason: 'Verified against route sheet' }));

  assert.equal(result.currentStatus, 'delivered');
  assert.equal(result.snapshot?.amountMinor, '95');
  assert.equal(result.events.at(-1)?.replacedEventId, initial.events[0]?.id);
  assert.equal(result.version, 3);
  assert.equal(snapshots.length, 1); assert.equal(corrections.length, 1);
  assert.deepEqual((audits[0] as { oldValue: unknown }).oldValue, { status: 'skipped_by_customer', version: 2 });
  assert.deepEqual((audits[0] as { newValue: unknown }).newValue, { status: 'delivered', actualQuantity: '1.5', version: 3 });
  const notification = notifications[0] as { id: string; recipientUserId: string; type: string; payload: unknown };
  assert.deepEqual(notification, { id: notification.id, vendorId, recipientUserId: customerId, type: 'delivery_corrected', payload: { scheduledDeliveryId: deliveryId } });
});

void test('correction locks before resolving a missing delivered snapshot, including a legacy delivered record', async () => {
  const tx = {} as TransactionContext;
  const legacy = { ...initial, currentStatus: 'delivered' as const, actualQuantity: '1', snapshot: undefined };
  const calls: string[] = [];
  const authorization: Pick<TenantAuthorizationExecutor, 'execute'> = { execute: <T>(_input: unknown, work: (current: TransactionContext) => Promise<T>) => work(tx) };
  const service = new DefaultDeliveryCorrectionService(
    authorization,
    {
      lockCorrection: () => { calls.push('lock'); return Promise.resolve(legacy); },
      getVendorDetail: () => { calls.push('detail'); return Promise.resolve({ ...legacy, snapshot: { amountMinor: '95', currency: 'INR', pricingLevel: 'global' as const, sourcePriceId: randomUUID(), sourcePriceType: 'global_price' as const, resolvedAt: new Date() } }); },
      createPriceSnapshot: () => { calls.push('snapshot'); return Promise.resolve(); },
      appendCorrection: () => { calls.push('append'); return Promise.resolve(legacy); },
    } as unknown as DeliveryStore,
    { resolve: () => { calls.push('price'); return Promise.resolve({ amountMinor: '95', currency: 'INR', pricingLevel: 'global' as const, sourcePriceId: randomUUID(), sourcePriceType: 'global_price' as const, resolvedAt: new Date() }); } },
    { append: () => Promise.resolve() }, { append: () => Promise.resolve() },
  );
  await requestContextStore.run({ correlationId: randomUUID() }, () => service.correct(admin, vendorId, deliveryId, { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1.5', reason: 'Correct legacy delivery' }));
  assert.deepEqual(calls, ['lock', 'price', 'snapshot', 'append', 'detail']);
});

void test('correction rejects a non-final delivery before resolving price or creating a snapshot', async () => {
  const calls: string[] = [];
  const authorization: Pick<TenantAuthorizationExecutor, 'execute'> = { execute: <T>(_input: unknown, work: (current: TransactionContext) => Promise<T>) => work({} as TransactionContext) };
  const service = new DefaultDeliveryCorrectionService(
    authorization,
    {
      lockCorrection: () => { calls.push('lock'); return Promise.resolve({ ...initial, currentStatus: 'scheduled' }); },
      createPriceSnapshot: () => { calls.push('snapshot'); return Promise.resolve(); },
    } as unknown as DeliveryStore,
    { resolve: () => { calls.push('price'); return Promise.resolve(undefined); } },
    { append: () => Promise.resolve() }, { append: () => Promise.resolve() },
  );

  await assert.rejects(
    requestContextStore.run({ correlationId: randomUUID() }, () => service.correct(admin, vendorId, deliveryId, { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1', reason: 'Valid reason' })),
    (error: unknown) => (error as { code?: string }).code === 'DELIVERY_NOT_FINALIZED',
  );
  assert.deepEqual(calls, ['lock']);
});

void test('correction rejects missing or invalid delivered quantity before resolving price or creating a snapshot', async () => {
  for (const actualQuantity of [undefined, '0']) {
    const calls: string[] = [];
    const authorization: Pick<TenantAuthorizationExecutor, 'execute'> = { execute: <T>(_input: unknown, work: (current: TransactionContext) => Promise<T>) => work({} as TransactionContext) };
    const service = new DefaultDeliveryCorrectionService(
      authorization,
      {
        lockCorrection: () => { calls.push('lock'); return Promise.resolve(initial); },
        createPriceSnapshot: () => { calls.push('snapshot'); return Promise.resolve(); },
      } as unknown as DeliveryStore,
      { resolve: () => { calls.push('price'); return Promise.resolve(undefined); } },
      { append: () => Promise.resolve() }, { append: () => Promise.resolve() },
    );

    await assert.rejects(
      requestContextStore.run({ correlationId: randomUUID() }, () => service.correct(admin, vendorId, deliveryId, { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity, reason: 'Valid reason' })),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_DELIVERY_QUANTITY',
    );
    assert.deepEqual(calls, ['lock']);
  }
});
