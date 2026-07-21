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
import { ListMembershipsQueryDto } from '../src/memberships/http/membership.dto.js';

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
  lifecycle: 'current' as const,
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

void test('lifecycle controllers publish accurate OpenAPI operation summaries', () => {
  for (const [controller, method, summary] of [
    [MembershipController, 'list', 'List memberships in the selected lifecycle'],
    [MembershipController, 'get', 'Read a membership in the selected lifecycle'],
    [UserLifecycleController, 'list', 'List platform users in the selected lifecycle'],
    [UserLifecycleController, 'get', 'Read a platform user in the selected lifecycle'],
  ] as const) {
    const operation = Reflect.getMetadata(
      'swagger/apiOperation',
      controller.prototype[method],
    ) as { summary?: string } | undefined;

    assert.equal(
      operation?.summary,
      summary,
    );
  }
});

void test('membership status OpenAPI metadata does not claim an unconditional active default', () => {
  const metadata = Reflect.getMetadata(
    'swagger/apiModelProperties',
    ListMembershipsQueryDto.prototype,
    'status',
  ) as Record<string, unknown> | undefined;

  assert.equal(metadata?.default, undefined);
});

void test('membership controller maps list results to the public DTO shape', async () => {
  let receivedLifecycle: unknown;
  const service = {
    list: (_actor: Actor, _vendorId: string, query: { lifecycle: string }) => {
      receivedLifecycle = query.lifecycle;
      return (
      Promise.resolve({
        items: [{ ...directoryMembership, deletedAt: at }],
        nextCursor: membership.id,
        internalCount: 1,
      }));
    },
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
  assert.equal(receivedLifecycle, 'current');
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
    lifecycle: 'deleted' as const,
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

void test('membership controller exposes lifecycle-aware detail without deletion metadata', async () => {
  let received: unknown;
  const service = {
    get: (_actor: Actor, _vendorId: string, membershipId: string, lifecycle: string) => {
      received = { membershipId, lifecycle };
      return Promise.resolve({ ...directoryMembership, lifecycle: 'deleted', deletedAt: at });
    },
  } as unknown as MembershipService;
  const controller = new MembershipController(service);

  const response = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000005', actor },
    () => controller.get(membership.vendorId, membership.id, { lifecycle: 'deleted' }),
  );

  assert.deepEqual(received, { membershipId: membership.id, lifecycle: 'deleted' });
  assert.deepEqual(response, { ...directoryMembership, lifecycle: 'deleted' });
});

void test('membership controller normalizes omitted detail lifecycle and publishes tsx metadata', async () => {
  let receivedLifecycle: unknown;
  const service = {
    get: (_actor: Actor, _vendorId: string, _membershipId: string, lifecycle: string) => {
      receivedLifecycle = lifecycle;
      return Promise.resolve(directoryMembership);
    },
  } as unknown as MembershipService;
  const controller = new MembershipController(service);

  await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000005', actor },
    () => controller.get(membership.vendorId, membership.id, {}),
  );

  assert.equal(receivedLifecycle, 'current');
  assert.deepEqual(
    Reflect.getMetadata('design:paramtypes', MembershipController.prototype, 'get'),
    [String, String, (await import('../src/common/http/record-lifecycle.dto.js')).LifecycleQueryDto],
  );
});

void test('membership controller returns only the enriched onboarding result', async () => {
  const result = {
    id: directoryMembership.id,
    vendorId: directoryMembership.vendorId,
    userId: directoryMembership.userId,
    role: directoryMembership.role,
    status: 'invited' as const,
    lifecycle: 'current' as const,
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
    lifecycle: 'current' as const,
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
    listUsers: () => Promise.reject(new Error('not used')),
    findUser: () => Promise.reject(new Error('not used')),
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
