import assert from 'node:assert/strict';
import test from 'node:test';

import type { MembershipService } from '../src/memberships/application/membership.service.js';
import {
  MembershipController,
  UserLifecycleController,
} from '../src/memberships/http/membership.controller.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import {
  PrismaUserLifecycleService,
  type UserLifecycleService,
} from '../src/identity/application/user-lifecycle.service.js';
import {
  type Actor,
  requestContextStore,
} from '../src/common/context/request-context.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000007',
  displayName: 'Test Administrator',
  platformRoles: ['platform_administrator'],
  authenticationMethod: 'administrator_mfa',
  memberships: [],
};

const at = new Date('2026-07-18T00:00:00.000Z');
const membership = {
  id: '00000000-0000-4000-8000-000000000002',
  vendorId: '00000000-0000-4000-8000-000000000003',
  userId: '00000000-0000-4000-8000-000000000004',
  role: 'customer' as const,
  status: 'active' as const,
  joinedAt: at,
  createdAt: at,
  updatedAt: at,
};

void test('membership controller maps list results to the public DTO shape', async () => {
  const service = {
    list: () =>
      Promise.resolve({
        items: [{ ...membership, deletedAt: at }],
        nextCursor: membership.id,
        internalCount: 1,
      }),
  } as unknown as MembershipService;
  const controller = new MembershipController(service);

  const response = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000005', actor },
    () => controller.list(membership.vendorId, { limit: 25 }),
  );

  assert.deepEqual(response, {
    items: [membership],
    nextCursor: membership.id,
  });
});

void test('user lifecycle controller maps restored users to the public DTO shape', async () => {
  const user = {
    id: membership.userId,
    displayName: 'Test Customer',
    status: 'active' as const,
    locale: 'en-IN',
    createdAt: at,
    updatedAt: at,
  };
  const service = {
    restore: () => Promise.resolve({ ...user, deletedAt: null, internalVersion: 2 }),
  } as unknown as UserLifecycleService;
  const controller = new UserLifecycleController(service);

  const response = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000005', actor },
    () => controller.restore(user.id, { reason: 'Account verified' }),
  );

  assert.deepEqual(response, user);
});

void test('user lifecycle protects the last active platform administrator', async () => {
  let queryNumber = 0;
  let mutations = 0;
  const targetId = '00000000-0000-4000-8000-000000000006';
  const tx = {
    $queryRaw: () => {
      queryNumber += 1;
      if (queryNumber === 1) return Promise.resolve([]); // Session advisory lock.
      if (queryNumber === 2) return Promise.resolve([{ user_id: targetId }]);
      return Promise.resolve([{ id: targetId }]);
    },
    user: {
      findFirst: () => Promise.resolve({ id: targetId }),
      update: () => {
        mutations += 1;
        return Promise.resolve({});
      },
    },
    session: {
      updateMany: () => {
        mutations += 1;
        return Promise.resolve({ count: 0 });
      },
    },
  };
  const prisma = {
    $transaction: (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaService;
  const service = new PrismaUserLifecycleService(prisma);

  await assert.rejects(
    service.softDelete(actor, targetId, 'Attempt to delete last administrator'),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'LAST_PLATFORM_ADMINISTRATOR',
  );
  assert.equal(mutations, 0);
});
