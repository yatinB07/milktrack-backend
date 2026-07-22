import assert from 'node:assert/strict';
import test from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { requestContextStore } from '../src/common/context/request-context.js';
import { AgentDeliveryController } from '../src/delivery/http/agent-delivery.controller.js';
import { AgentStopOutcomeRequestDto } from '../src/delivery/http/delivery.dto.js';

const actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', displayName: 'Agent', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [] } as const;
const vendorId = '00000000-0000-4000-8000-000000000003';
const routeStopId = '00000000-0000-4000-8000-000000000004';
const item = { scheduledDeliveryId: '00000000-0000-4000-8000-000000000005', expectedVersion: 1, actualQuantity: '1.25' };

void test('agent controller passes the actor and maps the complete authoritative stop', async () => {
  const value = { routeStopId, serviceDate: '2030-01-01', outcome: 'delivered' as const, items: [{ id: item.scheduledDeliveryId, householdId: 'household', subscriptionId: 'subscription', serviceDate: '2030-01-01', plannedQuantity: '1', actualQuantity: '1.25', currentStatus: 'delivered' as const, version: 2, finalizedAt: new Date('2030-01-01T01:00:01Z') }] };
  const calls: unknown[][] = [];
  const controller = new AgentDeliveryController({ record: (...args: unknown[]) => { calls.push(args); return Promise.resolve(value); } } as never);
  const body = { serviceDate: '2030-01-01', outcome: 'delivered' as const, occurredAt: '2030-01-01T01:00:00Z', items: [item] };
  const result = await requestContextStore.run({ correlationId: 'correlation', actor }, () => controller.record(vendorId, routeStopId, body));
  assert.deepEqual(calls, [[actor, vendorId, routeStopId, body]]);
  assert.deepEqual(result, { ...value, items: [{ ...value.items[0], finalizedAt: '2030-01-01T01:00:01.000Z' }] });
});

void test('agent outcome DTO validates the discriminated transport shape', async () => {
  const valid = [
    { serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T01:00:00Z', items: [item] },
    { serviceDate: '2030-01-01', outcome: 'missed', occurredAt: '2030-01-01T01:00:00+05:30', items: [{ scheduledDeliveryId: item.scheduledDeliveryId, expectedVersion: 1 }], reasonCode: 'access_blocked' },
    { serviceDate: '2030-01-01', outcome: 'skipped_by_agent', occurredAt: '2030-01-01T01:00:00Z', items: [{ scheduledDeliveryId: item.scheduledDeliveryId, expectedVersion: 1 }], reasonCode: 'other', note: 'Customer away', latitude: 18.52, longitude: 73.85 },
  ];
  for (const body of valid) assert.equal((await validate(plainToInstance(AgentStopOutcomeRequestDto, body))).length, 0);
  const invalid = [
    { ...valid[0], items: [] },
    { ...valid[0], occurredAt: '2030-01-01T01:00:00' },
    { ...valid[0], items: [{ ...item, actualQuantity: '0' }] },
    { ...valid[0], items: [{ ...item, actualQuantity: '1e2' }] },
    { ...valid[0], note: 'not allowed' },
    { ...valid[1], reasonCode: 'customer_unavailable' },
    { ...valid[1], items: [item] },
    { ...valid[2], longitude: undefined },
    { ...valid[2], latitude: Number.NaN },
    { ...valid[2], note: 'x'.repeat(501) },
    { ...valid[2], note: '   ' },
    { ...valid[2], note: undefined },
  ];
  for (const body of invalid) assert.notEqual((await validate(plainToInstance(AgentStopOutcomeRequestDto, body))).length, 0);
});

void test('agent outcome route is the frozen POST endpoint', () => {
  assert.equal(Reflect.getMetadata('path', AgentDeliveryController), 'agent/vendors/:vendorId/route-stops/:routeStopId/outcomes');
  const method = Object.getOwnPropertyDescriptor(AgentDeliveryController.prototype, 'record')?.value as object;
  assert.equal(Reflect.getMetadata('method', method), 1);
  assert.equal(Reflect.getMetadata('__httpCode__', method), 201);
});
