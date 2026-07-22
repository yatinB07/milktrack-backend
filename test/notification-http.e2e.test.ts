import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import test from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';

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

void test('customer notification routes isolate current and former household records', async (t) => {
  const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
  const vendorId = randomUUID(); const userId = randomUUID(); const membershipId = randomUUID();
  const householdA = randomUUID(); const householdB = randomUUID(); const token = randomUUID();
  const notificationA = randomUUID(); const notificationB = randomUUID();
  const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
  const hash = (value: string) => createHmac('sha256', authKey).update(value).digest('hex');
  const app = await (await import('../src/bootstrap/create-app.js')).createApp({ logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    await owner.query('DELETE FROM notifications WHERE vendor_id=$1', [vendorId]);
    await owner.query('DELETE FROM household_members WHERE vendor_id=$1', [vendorId]);
    await owner.query('DELETE FROM households WHERE vendor_id=$1', [vendorId]);
    await owner.query('DELETE FROM vendor_memberships WHERE vendor_id=$1', [vendorId]);
    await owner.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
    await owner.query('DELETE FROM user_identities WHERE user_id=$1', [userId]);
    await owner.query('DELETE FROM users WHERE id=$1', [userId]);
    await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]);
    await owner.end();
  });
  await owner.query("INSERT INTO users(id,display_name,updated_at) VALUES($1,'Notification Customer',now())", [userId]);
  await owner.query("INSERT INTO user_identities(id,user_id,type,normalized_value,verified_at,is_primary,updated_at) VALUES($1,$2,'phone',$3,now(),true,now())", [randomUUID(), userId, `+91${userId.replaceAll('-', '').replace(/[a-f]/g, '1').slice(0, 10)}`]);
  await owner.query("INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,'Notification Vendor','Notification Vendor','active','Asia/Kolkata','INR',0,1,now())", [vendorId, `notification-${vendorId}`]);
  await owner.query("INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at) VALUES($1,$2,$3,'customer','active',now(),now())", [membershipId, vendorId, userId]);
  await owner.query("INSERT INTO sessions(id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at) VALUES($1,$2,$3,$4,'phone_otp','notification',now()+interval '1 hour',now()+interval '1 day',now())", [randomUUID(), userId, hash(token), hash(randomUUID())]);
  await owner.query("INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$3,'NOTIFY-A','Household A','Road','Pune','MH','411001','IN',now()),($2,$3,'NOTIFY-B','Household B','Road','Pune','MH','411001','IN',now())", [householdA, householdB, vendorId]);
  const householdMemberB = randomUUID();
  await owner.query("INSERT INTO household_members(id,vendor_id,household_id,customer_membership_id,status,joined_at,updated_at) VALUES($1,$3,$4,$5,'active',now(),now()),($2,$3,$6,$5,'active',now(),now())", [randomUUID(), householdMemberB, vendorId, householdA, membershipId, householdB]);
  await owner.query("INSERT INTO notifications(id,vendor_id,recipient_user_id,type,payload,created_at) VALUES($1,$3,$4,'leave_accepted',$5::jsonb,'2026-07-23T01:00:00Z'),($2,$3,$4,'leave_rejected',$6::jsonb,'2026-07-23T00:00:00Z')", [notificationA, notificationB, vendorId, userId, JSON.stringify({ householdId: householdA, leaveRequestId: randomUUID() }), JSON.stringify({ householdId: householdB, leaveRequestId: randomUUID() })]);

  const address = (app.getHttpServer() as Server).address(); assert.ok(address && typeof address !== 'string');
  const list = async (householdId: string) => fetch(`http://127.0.0.1:${address.port}/v1/customer/vendors/${vendorId}/households/${householdId}/notifications`, { headers: { authorization: `Bearer ${token}` } });
  const pageA = await list(householdA); assert.equal(pageA.status, 200, await pageA.clone().text());
  assert.deepEqual((await pageA.json() as { items: { id: string }[] }).items.map(({ id }) => id), [notificationA]);
  const pageB = await list(householdB); assert.equal(pageB.status, 200);
  assert.deepEqual((await pageB.json() as { items: { id: string }[] }).items.map(({ id }) => id), [notificationB]);

  await owner.query("UPDATE household_members SET status='ended',ended_at=now(),updated_at=now() WHERE id=$1", [householdMemberB]);
  const afterEndA = await list(householdA); assert.equal(afterEndA.status, 200);
  assert.deepEqual((await afterEndA.json() as { items: { id: string }[] }).items.map(({ id }) => id), [notificationA]);
  const endedB = await list(householdB); assert.equal(endedB.status, 403);
  assert.equal((await endedB.json() as { code: string }).code, 'FORBIDDEN');
});
