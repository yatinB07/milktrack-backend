import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor, VendorRole } from '../src/common/context/request-context.js';
import {
  PrismaMembershipService,
} from '../src/memberships/application/membership.service.js';
import type {
  MembershipRecord,
  MembershipRecordPage,
} from '../src/memberships/infrastructure/prisma-membership.store.js';

const actor: Actor = {
  userId: '10000000-0000-4000-8000-000000000001',
  sessionId: '10000000-0000-4000-8000-000000000002',
  displayName: 'Vendor Owner',
  authenticationMethod: 'administrator_mfa',
  platformRoles: [],
  memberships: [],
};
const vendorId = '10000000-0000-4000-8000-000000000003';
const tx = {} as TransactionContext;

function record(index: number, role: VendorRole = 'customer', status: MembershipRecord['status'] = 'active'): MembershipRecord {
  const at = new Date(Date.UTC(2030, 0, 1, 0, 0, 1000 - index));
  return {
    id: `membership-${index}`,
    vendorId,
    userId: `user-${index}`,
    role,
    status,
    joinedAt: status === 'active' ? at : null,
    endedAt: status === 'ended' ? at : null,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    createdAt: at,
    updatedAt: at,
  };
}

function harness(
  records: readonly MembershipRecord[],
  names: ReadonlyMap<string, string>,
) {
  const listQueries: Array<Readonly<{ cursor?: string; limit?: number; role?: VendorRole; status?: MembershipRecord['status'] }>> = [];
  const profileRequests: string[][] = [];
  const cursorFor = (membership: MembershipRecord) => `after:${membership.id}`;
  const store = {
    listActive: (_context: TransactionContext, query: (typeof listQueries)[number]): Promise<MembershipRecordPage> => {
      listQueries.push(query);
      const start = query.cursor
        ? records.findIndex(({ id }) => cursorFor({ id } as MembershipRecord) === query.cursor) + 1
        : 0;
      const limit = query.limit ?? 25;
      const items = records.slice(start, start + limit);
      const last = items.at(-1);
      return Promise.resolve({
        items,
        ...(last && start + items.length < records.length ? { nextCursor: cursorFor(last) } : {}),
      });
    },
    cursorFor,
  };
  const identities = {
    profiles: (_context: TransactionContext, userIds: readonly string[]) => {
      profileRequests.push([...userIds]);
      return Promise.resolve(new Map(userIds.map((userId) => [userId, {
        userId,
        displayName: names.get(userId) ?? `Member ${userId}`,
        phone: `+91${userId}`,
        email: `${userId}@example.test`,
      }])));
    },
  };
  const authorization = {
    execute: <T>(input: { actor: Actor; vendorId: string }, operation: (context: TransactionContext) => Promise<T>) => {
      assert.equal(input.actor, actor);
      assert.equal(input.vendorId, vendorId);
      return operation(tx);
    },
  };
  return {
    service: new PrismaMembershipService(authorization, store as never, {} as never, identities as never),
    listQueries,
    profileRequests,
  };
}

void test('non-search membership pages retain the requested database limit and cursor', async () => {
  const records = [record(0), record(1), record(2)];
  const { service, listQueries, profileRequests } = harness(records, new Map());

  const page = await service.list(actor, vendorId, { limit: 2 });

  assert.deepEqual(page.items.map(({ id }) => id), ['membership-0', 'membership-1']);
  assert.equal(page.nextCursor, 'after:membership-1');
  assert.deepEqual(listQueries, [{ cursor: undefined, limit: 2, role: undefined, status: undefined }]);
  assert.deepEqual(profileRequests, [['user-0', 'user-1']]);
});

void test('search continuation resumes after first, middle, and tail matches without gaps or duplicates', async () => {
  const records = Array.from({ length: 101 }, (_, index) => record(index));
  const names = new Map([0, 50, 100].map((index) => [`user-${index}`, `Needle ${index}`]));
  const { service, listQueries, profileRequests } = harness(records, names);
  const seen: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await service.list(actor, vendorId, { search: 'needle', limit: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map(({ id }) => id));
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(seen, ['membership-0', 'membership-50', 'membership-100']);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(listQueries.map(({ limit }) => limit), [100, 100, 100]);
  assert.deepEqual(profileRequests.map(({ length }) => length), [100, 100, 50]);
});

void test('a full search window with no matches returns continuation to the unexamined tail', async () => {
  const records = Array.from({ length: 101 }, (_, index) => record(index));
  const { service, listQueries, profileRequests } = harness(
    records,
    new Map([['user-100', 'Only tail needle']]),
  );

  const first = await service.list(actor, vendorId, { search: 'needle', limit: 25 });
  const second = await service.list(actor, vendorId, {
    search: 'needle',
    limit: 25,
    cursor: first.nextCursor,
  });

  assert.deepEqual(first.items, []);
  assert.equal(first.nextCursor, 'after:membership-99');
  assert.deepEqual(second.items.map(({ id }) => id), ['membership-100']);
  assert.equal(second.nextCursor, undefined);
  assert.equal(listQueries.length, 2);
  assert.deepEqual(profileRequests.map(({ length }) => length), [100, 1]);
});

void test('search treats text literally, composes role and status, and bounds a simulated 100k tail', async () => {
  const totalCandidates = 100_000;
  let storeCalls = 0;
  let profileCalls = 0;
  let examined = 0;
  const store = {
    listActive: (_context: TransactionContext, query: { limit?: number; role?: VendorRole; status?: MembershipRecord['status'] }) => {
      storeCalls += 1;
      assert.deepEqual(query, { cursor: undefined, limit: 100, role: 'delivery_agent', status: 'invited' });
      const items = Array.from({ length: query.limit ?? 25 }, (_, index) => record(index, 'delivery_agent', 'invited'));
      return Promise.resolve({ items, nextCursor: totalCandidates > items.length ? 'after:membership-99' : undefined });
    },
    cursorFor: (membership: MembershipRecord) => `after:${membership.id}`,
  };
  const identities = {
    profiles: (_context: TransactionContext, userIds: readonly string[]) => {
      profileCalls += 1;
      examined = userIds.length;
      return Promise.resolve(new Map(userIds.map((userId) => [userId, {
        userId,
        displayName: userId === 'user-75' ? 'Literal %_\\ match' : `Other ${userId}`,
      }])));
    },
  };
  const authorization = { execute: <T>(_input: unknown, operation: (context: TransactionContext) => Promise<T>) => operation(tx) };
  const service = new PrismaMembershipService(authorization, store as never, {} as never, identities as never);

  const page = await service.list(actor, vendorId, {
    search: '%_\\',
    limit: 1,
    role: 'delivery_agent',
    status: 'invited',
  });

  assert.deepEqual(page.items.map(({ id }) => id), ['membership-75']);
  assert.equal(page.nextCursor, 'after:membership-75');
  assert.equal(storeCalls, 1);
  assert.equal(profileCalls, 1);
  assert.equal(examined, 100);
});
