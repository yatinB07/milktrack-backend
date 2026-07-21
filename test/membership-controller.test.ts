import assert from 'node:assert/strict';
import test from 'node:test';

import type { MembershipService } from '../src/memberships/application/membership.service.js';
import {
  MembershipController,
  UserLifecycleController,
} from '../src/memberships/http/membership.controller.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import {
  DefaultUserLifecycleService,
  type UserLifecycleStore,
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

const directoryMembership = {
  ...membership,
  displayName: 'Test Customer',
  phone: '+919876543210',
  email: 'customer@example.test',
};

void test('membership controller maps list results to the public DTO shape', async () => {
  const service = {
    list: () =>
      Promise.resolve({
        items: [{ ...directoryMembership, deletedAt: at }],
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
    items: [directoryMembership],
    nextCursor: membership.id,
  });
});

void test('membership controller forwards vendor directory filters', async () => {
  let received: unknown;
  const service = {
    list: (_actor: Actor, _vendorId: string, query: unknown) => {
      received = query;
      return Promise.resolve({ items: [] });
    },
  } as unknown as MembershipService;
  const controller = new MembershipController(service);
  const query = {
    role: 'delivery_agent' as const,
    status: 'invited' as const,
    search: '  priya  ',
  };

  await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000005', actor },
    () => controller.list(membership.vendorId, query),
  );

  assert.deepEqual(received, query);
});

void test('membership controller returns only the enriched onboarding result', async () => {
  const result = {
    id: directoryMembership.id,
    vendorId: directoryMembership.vendorId,
    userId: directoryMembership.userId,
    role: directoryMembership.role,
    status: 'invited' as const,
    displayName: directoryMembership.displayName,
    phone: directoryMembership.phone,
    email: directoryMembership.email,
    createdAt: directoryMembership.createdAt,
    updatedAt: directoryMembership.updatedAt,
  };
  const service = {
    onboard: () => Promise.resolve({ ...result, matchedExistingUser: true, otp: 'secret' }),
  } as unknown as MembershipService;
  const controller = new MembershipController(service);

  const response = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000005', actor },
    () =>
      (controller as unknown as {
        onboard(vendorId: string, request: { displayName: string; phone: string; role: 'customer' }): Promise<unknown>;
      }).onboard(membership.vendorId, {
        displayName: 'Test Customer',
        phone: '+919876543210',
        role: 'customer',
      }),
  );

  assert.deepEqual(response, result);
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
  let mutations = 0;
  const targetId = '00000000-0000-4000-8000-000000000006';
  const store = {
    run: (operation) =>
      operation({
        lockSessionUser: () => Promise.resolve(),
        lockActivePlatformAdministrators: () => Promise.resolve([targetId]),
        lockManagedVendors: () => Promise.resolve([]),
        ownerCounts: () => Promise.resolve([]),
        lockUser: () => Promise.reject(new Error('must not query target')),
        softDelete: () => {
          mutations += 1;
          return Promise.resolve();
        },
        deactivate: () => Promise.reject(new Error('must not deactivate')),
        restore: () => Promise.reject(new Error('must not restore')),
        revokeSessions: () => {
          mutations += 1;
          return Promise.resolve();
        },
        appendAudit: () => Promise.resolve(),
      }),
  } satisfies UserLifecycleStore;
  const service = new DefaultUserLifecycleService(store);

  await assert.rejects(
    service.softDelete(actor, targetId, 'Attempt to delete last administrator'),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'LAST_PLATFORM_ADMINISTRATOR',
  );
  assert.equal(mutations, 0);
});
