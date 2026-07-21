import assert from 'node:assert/strict';
import test from 'node:test';

import type { Actor } from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import {
  DefaultUserLifecycleService,
  type UserLifecycleRecord,
  type UserLifecycleStore,
} from '../src/identity/application/user-lifecycle.service.js';
import { PrismaUserLifecycleStore } from '../src/identity/infrastructure/prisma-user-lifecycle.store.js';
import * as membershipDtos from '../src/memberships/http/membership.dto.js';

const at = new Date('2030-01-01T00:00:00.000Z');
const admin: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Platform Administrator',
  authenticationMethod: 'administrator_mfa',
  platformRoles: ['platform_administrator'],
  memberships: [],
};

void test('platform user list publishes the frozen deterministic DTO schema name', () => {
  assert.equal(
    typeof (membershipDtos as Record<string, unknown>).PlatformUserListResponseDto,
    'function',
  );
});

function record(id: string, deleted = false): UserLifecycleRecord {
  return {
    id,
    displayName: `User ${id}`,
    status: 'active',
    locale: 'en-IN',
    deactivatedAt: null,
    deletedAt: deleted ? at : null,
    createdAt: at,
    updatedAt: at,
  };
}

void test('user discovery enforces MFA user management and projects lifecycle without deletion metadata', async () => {
  const current = record('00000000-0000-4000-8000-000000000010');
  const deleted = record('00000000-0000-4000-8000-000000000011', true);
  const calls: unknown[] = [];
  const store = {
    listUsers: (query: unknown) => {
      calls.push(['list', query]);
      return Promise.resolve({ items: [query && (query as { lifecycle: string }).lifecycle === 'deleted' ? deleted : current], nextCursor: 'next' });
    },
    findUser: (userId: string, lifecycle: string) => {
      calls.push(['get', userId, lifecycle]);
      return Promise.resolve(lifecycle === 'deleted' ? deleted : current);
    },
  } as unknown as UserLifecycleStore;
  const service = new DefaultUserLifecycleService(store);

  const currentPage = await service.list(admin, { lifecycle: 'current' });
  const deletedResult = await service.get(admin, deleted.id, 'deleted');

  assert.deepEqual(currentPage, {
    items: [{
      id: current.id,
      displayName: current.displayName,
      status: current.status,
      locale: current.locale,
      lifecycle: 'current',
      createdAt: at,
      updatedAt: at,
    }],
    nextCursor: 'next',
  });
  assert.deepEqual(deletedResult, {
    id: deleted.id,
    displayName: deleted.displayName,
    status: deleted.status,
    locale: deleted.locale,
    lifecycle: 'deleted',
    createdAt: at,
    updatedAt: at,
  });
  assert.deepEqual(calls, [
    ['list', { lifecycle: 'current' }],
    ['get', deleted.id, 'deleted'],
  ]);

  const denied = [
    { ...admin, authenticationMethod: 'phone_otp' as const },
    { ...admin, platformRoles: ['product_owner'] as const },
    { ...admin, platformRoles: [] },
  ];
  for (const actor of denied) {
    await assert.rejects(
      service.list(actor, { lifecycle: 'current' }),
      (error: unknown) => error instanceof ApplicationError && error.code === 'FORBIDDEN',
    );
  }
  assert.equal(calls.length, 2);
});

void test('Prisma user discovery defaults to 25, caps at 100, separates lifecycle, and uses a stable cursor', async () => {
  const current = record('00000000-0000-4000-8000-000000000020');
  const deleted = record('00000000-0000-4000-8000-000000000021', true);
  const queries: unknown[] = [];
  const prisma = {
    user: {
      findMany: (query: unknown) => {
        queries.push(query);
        return Promise.resolve([current, deleted]);
      },
      findFirst: (query: unknown) => {
        queries.push(query);
        return Promise.resolve(deleted);
      },
    },
  };
  const store = new PrismaUserLifecycleStore(prisma as never, {} as never);

  const first = await store.listUsers({ lifecycle: 'current' });
  await store.listUsers({ lifecycle: 'deleted', limit: 100, cursor: first.nextCursor });
  await store.findUser(deleted.id, 'deleted');

  assert.equal(first.items.length, 2);
  assert.equal(first.nextCursor, undefined);
  assert.deepEqual(queries, [
    {
      where: { deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 26,
      select: {
        id: true, displayName: true, status: true, locale: true,
        deactivatedAt: true, deletedAt: true, createdAt: true, updatedAt: true,
      },
    },
    {
      where: { deletedAt: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 101,
      select: {
        id: true, displayName: true, status: true, locale: true,
        deactivatedAt: true, deletedAt: true, createdAt: true, updatedAt: true,
      },
    },
    {
      where: { id: deleted.id, deletedAt: { not: null } },
      select: {
        id: true, displayName: true, status: true, locale: true,
        deactivatedAt: true, deletedAt: true, createdAt: true, updatedAt: true,
      },
    },
  ]);

  await assert.rejects(store.listUsers({ lifecycle: 'current', limit: 101 }), {
    code: 'INVALID_PAGINATION',
  });
  await assert.rejects(store.listUsers({ lifecycle: 'current', cursor: 'tampered' }), {
    code: 'INVALID_CURSOR',
  });
});
