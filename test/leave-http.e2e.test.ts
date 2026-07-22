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
const port = 38901;
let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;

@Module({
  controllers: [CustomerLeaveController, VendorLeaveController],
  providers: [
    { provide: LeaveService, useValue: { preview: () => Promise.resolve({ timezone: 'Asia/Kolkata', skipCutoffMinutes: 60, lateLeavePolicy: 'approval', onTimeCount: 1, lateCount: 0, items: [] }) } },
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
  const valid = { startDate: '2030-01-02', endDate: '2030-01-03', subscriptionIds: [subscriptionId] };
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' }, body: JSON.stringify(valid) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { timezone: 'Asia/Kolkata', skipCutoffMinutes: 60, lateLeavePolicy: 'approval', onTimeCount: 1, lateCount: 0, items: [] });
  const invalid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' }, body: JSON.stringify({ ...valid, unexpected: true }) });
  assert.equal(invalid.status, 400);
});

void test('leave DTO metadata can be composed into the application OpenAPI document', () => {
  assert.doesNotThrow(() => createOpenApiDocument(app!));
});
