import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { createOpenApiDocument } from '../src/bootstrap/configure-app.js';
import { RequestContextStore, requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { AuthenticationService } from '../src/identity/application/authentication.service.js';
import { LeaveService } from '../src/leave/application/leave.service.js';
import { CustomerLeaveController } from '../src/leave/http/customer-leave.controller.js';
import { VendorLeaveController } from '../src/leave/http/vendor-leave.controller.js';

const actor: Actor = { userId: randomUUID(), sessionId: randomUUID(), displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [] };
const vendorId = randomUUID(); const householdId = randomUUID(); const subscriptionId = randomUUID();
const requestId = randomUUID(); const revisionId = randomUUID(); const decisionId = randomUUID(); const slotId = randomUUID();
const productId = randomUUID();
const port = 38901;
let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
const detail = {
  id: requestId, vendorId, householdId, currentStatus: 'accepted' as const, currentRevisionId: revisionId, version: 2,
  createdAt: new Date('2030-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-01T01:00:00.000Z'), availableActions: ['amend', 'cancel'] as const,
  rawAuditPayload: { token: 'secret' }, phone: '+910000000000', address: 'Private', gps: { latitude: 1 },
  revisions: [{ id: revisionId, action: 'create' as const, startDate: '2030-01-02', endDate: '2030-01-03', source: 'customer' as const,
    createdBy: actor.userId, status: 'accepted' as const, createdAt: new Date('2030-01-01T00:00:00.000Z'), subscriptionIds: [subscriptionId], subscriptions: [],
    subscriptionLabels: [{ subscriptionId, productId, productName: 'Milk', deliverySlotId: slotId, deliverySlotName: 'Morning' }],
    decisions: [{ id: decisionId, subscriptionId, deliverySlotId: slotId, serviceDate: '2030-01-02', status: 'pending' as const,
      previousEffectiveStatus: 'scheduled' as const, requestedEffectiveStatus: 'skipped_by_customer' as const, version: 1,
      cutoffAt: new Date('2030-01-01T23:00:00.000Z'), source: 'customer' as const, productId, productName: 'Milk', deliverySlotName: 'Morning',
      createdAt: new Date('2030-01-01T00:30:00.000Z'), availableActions: ['approve', 'reject'] as const, prismaOnly: true }],
  }],
};

@Module({
  controllers: [CustomerLeaveController, VendorLeaveController],
  providers: [
    { provide: LeaveService, useValue: {
      preview: () => Promise.resolve({ timezone: 'Asia/Kolkata', skipCutoffMinutes: 60, lateLeavePolicy: 'approval', onTimeCount: 1, lateCount: 0, items: [] }),
      getCustomer: () => Promise.resolve(detail), getVendorRequest: () => Promise.resolve(detail),
    } },
    { provide: AuthenticationService, useValue: { authenticate: () => Promise.resolve(actor) } },
    { provide: RequestContextStore, useValue: requestContextStore },
  ],
})
class LeaveHttpTestModule {}

test.before(async () => {
  app = await NestFactory.create(LeaveHttpTestModule, { logger: false });
  app.use((_: unknown, __: unknown, next: () => void) => requestContextStore.run({ correlationId: randomUUID(), actor }, next));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(port, '127.0.0.1');
});
test.after(() => app?.close());

void test('customer leave preview uses the frozen route and rejects unknown request fields', async () => {
  const url = `http://127.0.0.1:${port}/customer/vendors/${vendorId}/households/${householdId}/leave-requests/preview`;
  const valid = { startDate: '2030-01-02', endDate: '2030-01-03', subscriptionIds: [subscriptionId], cursor: 'opaque-page', limit: 25 };
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' }, body: JSON.stringify(valid) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { timezone: 'Asia/Kolkata', skipCutoffMinutes: 60, lateLeavePolicy: 'approval', onTimeCount: 1, lateCount: 0, items: [] });
  const invalid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' }, body: JSON.stringify({ ...valid, unexpected: true }) });
  assert.equal(invalid.status, 400);
});

void test('leave DTO metadata can be composed into the application OpenAPI document', () => {
  assert.doesNotThrow(() => createOpenApiDocument(app!));
});

void test('customer and vendor detail routes expose distinct safe timeline actions', async () => {
  const customer = await fetch(`http://127.0.0.1:${port}/customer/vendors/${vendorId}/households/${householdId}/leave-requests/${requestId}`,
    { headers: { authorization: 'Bearer test' } });
  assert.equal(customer.status, 200);
  const customerBody = await customer.json() as Record<string, unknown>;
  assert.deepEqual(customerBody.availableActions, ['amend', 'cancel']);
  assert.equal((((customerBody.revisions as Array<{ subscriptionLabels: Array<{ productName: string }> }>)[0]?.subscriptionLabels[0]?.productName)), 'Milk');
  assert.equal((((customerBody.revisions as Array<{ decisions: Array<{ cutoffAt: string; source: string }> }>)[0]?.decisions[0]?.cutoffAt)), '2030-01-01T23:00:00.000Z');
  const vendor = await fetch(`http://127.0.0.1:${port}/vendors/${vendorId}/leave-requests/${requestId}`,
    { headers: { authorization: 'Bearer test' } });
  assert.equal(vendor.status, 200);
  const vendorBody = await vendor.json() as Record<string, unknown>;
  assert.equal('availableActions' in vendorBody, false);
  assert.deepEqual(((vendorBody.revisions as Array<{ decisions: Array<{ availableActions: string[] }> }>)[0]?.decisions[0]?.availableActions), ['approve', 'reject']);
  for (const body of [customerBody, vendorBody]) {
    const serialized = JSON.stringify(body);
    for (const unsafeKey of ['rawAuditPayload', 'phone', 'address', 'token', 'gps', 'prismaOnly']) assert.equal(serialized.includes(unsafeKey), false);
  }
});
