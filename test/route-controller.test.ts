import assert from 'node:assert/strict';
import test from 'node:test';

import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { RouteController } from '../src/routing/http/route.controller.js';
import { RoutePageQueryDto } from '../src/routing/http/route.dto.js';

const actor: Actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', displayName: 'Owner', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] };

void test('route controller maps an explicit public response and lifecycle status codes', async () => {
  const at = new Date('2026-07-20T10:00:00Z');
  const route = { id: '00000000-0000-4000-8000-000000000010', vendorId: '00000000-0000-4000-8000-000000000020', code: 'MORNING', name: 'Morning', deliverySlotId: '00000000-0000-4000-8000-000000000030', status: 'active' as const, lifecycle: 'current' as const, version: 1, createdAt: at, updatedAt: at };
  const controller = new RouteController({ create: () => Promise.resolve(route) } as never);
  const response = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000040', actor }, () => controller.create(route.vendorId, { code: 'morning', name: ' Morning ', deliverySlotId: route.deliverySlotId }));
  assert.deepEqual(response, { ...route, createdAt: at.toISOString(), updatedAt: at.toISOString() });
  for (const method of ['deactivate', 'reactivate', 'restore']) {
    const handler = Object.getOwnPropertyDescriptor(RouteController.prototype, method)?.value as object;
    assert.equal(Reflect.getMetadata('__httpCode__', handler), 200);
  }
});

void test('route controller normalizes root lifecycle reads without exposing deletion metadata', async () => {
  const at = new Date('2026-07-20T10:00:00Z');
  const route = { id: '00000000-0000-4000-8000-000000000010', vendorId: '00000000-0000-4000-8000-000000000020', code: 'MORNING', name: 'Morning', deliverySlotId: '00000000-0000-4000-8000-000000000030', status: 'inactive' as const, lifecycle: 'deleted' as const, version: 2, createdAt: at, updatedAt: at };
  const calls: unknown[][] = [];
  const controller = new RouteController({ list: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ items: [route] }); }, get: (...args: unknown[]) => { calls.push(args); return Promise.resolve(route); } } as never);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000040', actor }, async () => {
    const page = await controller.list(route.vendorId, {});
    const detail = await controller.get(route.vendorId, route.id, { lifecycle: 'deleted' });
    assert.equal(page.items[0]?.lifecycle, 'deleted');
    assert.equal(detail.lifecycle, 'deleted');
    assert.equal('deletedAt' in detail, false);
    assert.equal('deletedBy' in detail, false);
    assert.equal('deletionReason' in detail, false);
  });
  assert.deepEqual(calls.map((args) => args.at(-1)), [{ lifecycle: 'current' }, 'deleted']);
});

void test('route list status schema does not promise one lifecycle default', () => {
  const status = Reflect.getMetadata('swagger/apiModelProperties', RoutePageQueryDto.prototype, 'status') as { default?: unknown };
  assert.equal(status.default, undefined);
});

void test('route root lifecycle operations publish summaries', () => {
  assert.deepEqual(
    ['list', 'get'].map((key) => (Reflect.getMetadata('swagger/apiOperation', RouteController.prototype[key as 'list' | 'get']) as { summary?: string } | undefined)?.summary),
    ['List routes in the selected lifecycle', 'Read a route in the selected lifecycle'],
  );
});
