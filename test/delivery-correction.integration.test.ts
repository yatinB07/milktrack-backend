import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import type { TenantAuthorizationExecutor } from '../src/authorization/application/tenant-authorization.executor.js';
import { DefaultDeliveryCorrectionService } from '../src/delivery/application/delivery-correction.service.js';
import type { DeliveryDetail, DeliveryStore } from '../src/delivery/application/delivery.store.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import type { DeliveryPriceService } from '../src/pricing/application/delivery-price.service.js';

const vendorId = randomUUID();
const deliveryId = randomUUID();
const actor: Actor = { userId: randomUUID(), sessionId: randomUUID(), displayName: 'Owner', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] };
const detail = (): DeliveryDetail => ({
  id: deliveryId, vendorId, householdId: randomUUID(), subscriptionId: randomUUID(), productId: randomUUID(), unitId: randomUUID(), deliverySlotId: randomUUID(), serviceDate: '2030-01-01', plannedQuantity: '1', currentStatus: 'delivered', actualQuantity: '1', version: 2, finalizedAt: new Date(), events: [], snapshot: { amountMinor: '95', currency: 'INR', pricingLevel: 'global', sourcePriceId: randomUUID(), sourcePriceType: 'global_price', resolvedAt: new Date() }, customerUserIds: [randomUUID()],
});

void test('correction failures do not acknowledge a replacement when audit or notification persistence fails', async () => {
  const calls: string[] = []; const current = detail();
  const service = new DefaultDeliveryCorrectionService(
    { execute: (_input: unknown, work: (tx: never) => Promise<unknown>) => work({} as never) } as unknown as TenantAuthorizationExecutor,
    { getVendorDetail: () => Promise.resolve(current), appendCorrection: () => { calls.push('correction'); return Promise.resolve(current); } } as unknown as DeliveryStore,
    {} as DeliveryPriceService,
    { append: () => Promise.reject(new Error('audit unavailable')) },
    { append: () => { calls.push('notification'); return Promise.resolve(); } },
  );
  await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service.correct(actor, vendorId, deliveryId, { expectedVersion: 2, replacementOutcome: 'missed', reason: 'Correct route record' })), /audit unavailable/u);
  assert.deepEqual(calls, ['correction']);
});

void test('correction rejects a scheduled delivery before an audit or notification is appended', async () => {
  const service = new DefaultDeliveryCorrectionService(
    { execute: (_input: unknown, work: (tx: never) => Promise<unknown>) => work({} as never) } as unknown as TenantAuthorizationExecutor,
    { getVendorDetail: () => Promise.resolve({ ...detail(), currentStatus: 'scheduled', finalizedAt: undefined, snapshot: undefined, actualQuantity: undefined }), appendCorrection: () => Promise.reject(new ApplicationError('DELIVERY_NOT_FINALIZED', 'Delivery is not finalized', 409)) } as unknown as DeliveryStore,
    {} as DeliveryPriceService, { append: () => Promise.resolve() }, { append: () => Promise.resolve() },
  );
  await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service.correct(actor, vendorId, deliveryId, { expectedVersion: 1, replacementOutcome: 'missed', reason: 'Correct route record' })), (error: unknown) => error instanceof ApplicationError && error.code === 'DELIVERY_NOT_FINALIZED');
});
