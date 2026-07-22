import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { CustomerNotificationController } from '../src/notifications/http/customer-notification.controller.js';

void test('customer notification controller exposes only the frozen customer list route and safe response', async () => {
  const vendorId = randomUUID(); const householdId = randomUUID(); const actor: Actor = { userId: randomUUID(), sessionId: randomUUID(), displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [] };
  const service = { listCustomer: (_actor: Actor, seenVendorId: string, seenHouseholdId: string) => Promise.resolve({ items: [{ id: randomUUID(), type: 'leave_accepted', payload: { leaveRequestId: randomUUID() }, readAt: null, createdAt: new Date('2026-07-22T00:00:00.000Z') }], nextCursor: 'next' }) };
  const controller = new CustomerNotificationController(service as never);
  const page = await requestContextStore.run({ correlationId: randomUUID(), actor }, () => controller.list(vendorId, householdId, {}));
  assert.deepEqual(Object.keys(page.items[0] ?? {}).sort(), ['createdAt', 'id', 'payload', 'type']); assert.equal(page.nextCursor, 'next');
  assert.equal(Reflect.getMetadata('path', CustomerNotificationController), 'customer/vendors/:vendorId/households/:householdId/notifications');
});
