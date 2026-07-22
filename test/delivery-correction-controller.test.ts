import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { VendorDeliveryController } from '../src/delivery/http/vendor-delivery.controller.js';
import { CorrectScheduledDeliveryRequestDto } from '../src/delivery/http/delivery.dto.js';

void test('vendor correction route forwards its validated command and maps the authoritative detail', async () => {
  const vendorId = randomUUID(); const deliveryId = randomUUID();
  const actor: Actor = { userId: randomUUID(), sessionId: randomUUID(), displayName: 'Admin', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] };
  const result = { id: deliveryId, vendorId, householdId: randomUUID(), subscriptionId: randomUUID(), productId: randomUUID(), unitId: randomUUID(), deliverySlotId: randomUUID(), serviceDate: '2030-01-01', plannedQuantity: '1', actualQuantity: '1', currentStatus: 'delivered' as const, version: 3, finalizedAt: new Date(), events: [] };
  const corrections = { correct: (seenActor: Actor, seenVendorId: string, seenDeliveryId: string, command: unknown) => { assert.equal(seenActor, actor); assert.equal(seenVendorId, vendorId); assert.equal(seenDeliveryId, deliveryId); assert.deepEqual(command, { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1', reason: 'Verified route sheet' }); return Promise.resolve(result); } };
  const controller = new VendorDeliveryController({ listVendor: () => Promise.resolve({ items: [] }), getVendorDetail: () => Promise.resolve(result) } as unknown as ConstructorParameters<typeof VendorDeliveryController>[0], corrections);
  const body = plainToInstance(CorrectScheduledDeliveryRequestDto, { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1', reason: 'Verified route sheet' });
  assert.equal((await validate(body)).length, 0);
  const response = await requestContextStore.run({ correlationId: randomUUID(), actor }, () => controller.correct(vendorId, deliveryId, body));
  assert.equal(response.currentStatus, 'delivered');
});

void test('correction request requires an exact replacement status, a positive quantity format, and a trimmed reason', async () => {
  for (const input of [
    { expectedVersion: 2, replacementOutcome: 'skipped_by_customer', reason: 'Valid reason' },
    { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '0', reason: 'Valid reason' },
    { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1', reason: ' padded ' },
  ]) assert.ok((await validate(plainToInstance(CorrectScheduledDeliveryRequestDto, input))).length > 0);
});
