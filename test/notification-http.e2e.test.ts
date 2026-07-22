import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import test from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware.js';
import { AuthenticationService } from '../src/identity/application/authentication.service.js';
import { NotificationService } from '../src/notifications/application/notification.service.js';
import { NotificationsModule } from '../src/notifications/notifications.module.js';

@Module({ imports: [NotificationsModule] })
class NotificationHttpTestModule {}

void test('GET exposes the frozen customer notification route and safe response', async (t) => {
  const vendorId = randomUUID(); const householdId = randomUUID();
  const actor: Actor = { userId: randomUUID(), sessionId: randomUUID(), displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [] };
  const notificationId = randomUUID(); const leaveRequestId = randomUUID(); const createdAt = new Date('2026-07-22T00:00:00.000Z');
  const app = await NestFactory.create(NotificationHttpTestModule, { logger: false, abortOnError: false });
  Object.assign(app.get(AuthenticationService), { authenticate: () => Promise.resolve(actor) });
  Object.assign(app.get(NotificationService), { listCustomer: (seenActor: Actor, seenVendorId: string, seenHouseholdId: string, query: unknown) => {
    assert.equal(seenActor, actor); assert.equal(seenVendorId, vendorId); assert.equal(seenHouseholdId, householdId);
    assert.equal((query as { cursor?: string }).cursor, undefined); assert.equal((query as { limit?: number }).limit, undefined);
    return Promise.resolve({ items: [{ id: notificationId, type: 'leave_accepted', payload: { leaveRequestId }, readAt: null, createdAt }], nextCursor: 'next' });
  } });
  app.setGlobalPrefix('v1');
  const context = new RequestContextMiddleware(requestContextStore, Buffer.alloc(32)); app.use(context.use.bind(context));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = (app.getHttpServer() as Server).address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/customer/vendors/${vendorId}/households/${householdId}/notifications`, { headers: { authorization: `Bearer ${randomUUID()}` } });
  const body = await response.text(); assert.equal(response.status, 200, body);
  const page = JSON.parse(body) as { items: readonly Record<string, unknown>[]; nextCursor?: string };
  assert.deepEqual(Object.keys(page.items[0] ?? {}).sort(), ['createdAt', 'id', 'payload', 'type']);
  assert.deepEqual(page.items[0], { id: notificationId, type: 'leave_accepted', payload: { leaveRequestId }, createdAt: createdAt.toISOString() });
  assert.equal(page.nextCursor, 'next');
});
