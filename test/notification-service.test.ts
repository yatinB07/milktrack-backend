import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { DefaultNotificationService } from '../src/notifications/application/notification.service.js';
import { PrismaNotificationStore } from '../src/notifications/infrastructure/prisma-notification.store.js';

const vendorId = randomUUID();
const householdId = randomUUID();
const recipientUserId = randomUUID();
const actor: Actor = {
  userId: recipientUserId, sessionId: randomUUID(), displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [],
  memberships: [{ id: randomUUID(), vendorId, vendorName: 'Milk', role: 'customer', status: 'active' }],
};

void test('notification writer appends through the caller transaction and rejects unsafe payload keys', async () => {
  const writes: unknown[] = [];
  const tx = wrapPrismaTransaction({ notification: { create: (input: unknown) => { writes.push(input); return Promise.resolve({}); } } } as never);
  const store = new PrismaNotificationStore();
  const notification = { id: randomUUID(), vendorId, householdId, recipientUserId, type: 'leave_accepted' as const, payload: { leaveRequestId: randomUUID() } };
  await store.append(tx, notification);
  const { payload, householdId: subjectHouseholdId, ...columns } = notification;
  assert.deepEqual(writes, [{ data: { ...columns, payload: { householdId: subjectHouseholdId, ...payload } } }]);
  await assert.rejects(
    store.append(tx, { ...notification, payload: { token: 'private' } } as never),
    (error: unknown) => error instanceof ApplicationError && error.code === 'INVALID_NOTIFICATION_PAYLOAD',
  );
});

void test('customer notifications authorize and scope the list to the active household recipient', async () => {
  const tx = {} as TransactionContext; const calls: unknown[][] = [];
  const authorization = { execute: (input: unknown, work: (current: TransactionContext) => Promise<unknown>) => { calls.push([input]); return work(tx); } };
  const households = { requireCustomerSubscriptionHousehold: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ householdId }); } };
  const store = { list: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ items: [{ id: randomUUID(), type: 'leave_accepted', payload: { leaveRequestId: randomUUID() }, readAt: null, createdAt: new Date('2026-07-22T00:00:00.000Z') }], nextCursor: 'cursor' }); } };
  const service = new DefaultNotificationService(authorization as never, households as never, store as never);
  const page = await service.listCustomer(actor, vendorId, householdId, { limit: 2 });
  assert.equal(page.items[0]?.type, 'leave_accepted'); assert.equal(page.nextCursor, 'cursor');
  assert.deepEqual(calls.slice(1), [[tx, actor, vendorId, householdId], [tx, vendorId, recipientUserId, { limit: 2 }]]);
  assert.equal((calls[0]?.[0] as { permission: string }).permission, 'customer:self');
});

void test('notification store uses descending created-at and id cursor pagination', async () => {
  const id = randomUUID(); const olderId = randomUUID(); const createdAt = new Date('2026-07-22T00:00:00.000Z'); let query: unknown;
  const tx = wrapPrismaTransaction({ notification: { findMany: (input: unknown) => { query = input; return Promise.resolve([{ id, type: 'leave_accepted', payload: { householdId, leaveRequestId: 'request' }, readAt: null, createdAt }, { id: olderId, type: 'leave_accepted', payload: { householdId, leaveRequestId: 'request' }, readAt: null, createdAt }]); } } } as never);
  const page = await new PrismaNotificationStore().list(tx, vendorId, recipientUserId, { limit: 1 });
  assert.deepEqual((query as { orderBy: unknown }).orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(page.items.length, 1); assert.ok(page.nextCursor);
});

void test('agent-reported skip uses the schema spelling only at the persistence boundary', async () => {
  const id = randomUUID(); const scheduledDeliveryId = randomUUID(); const createdAt = new Date('2026-07-22T00:00:00.000Z'); let persistedType: unknown;
  const tx = wrapPrismaTransaction({ notification: {
    create: ({ data }: { data: { type: unknown } }) => { persistedType = data.type; return Promise.resolve({}); },
    findMany: () => Promise.resolve([{ id, type: 'agent_skip', payload: { householdId, scheduledDeliveryId }, readAt: null, createdAt }]),
  } } as never);
  const store = new PrismaNotificationStore();
  await store.append(tx, { id, vendorId, householdId, recipientUserId, type: 'agent_reported_skip', payload: { scheduledDeliveryId } });
  const page = await store.list(tx, vendorId, recipientUserId, {});
  assert.equal(persistedType, 'agent_skip');
  assert.equal(page.items[0]?.type, 'agent_reported_skip');
});
