import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';

import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { RequestContextStore, requestContextStore } from '../src/common/context/request-context.js';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware.js';
import { ApplicationErrorFilter } from '../src/common/errors/application-error.filter.js';
import { AgentStopOutcomeService } from '../src/delivery/application/agent-stop-outcome.service.js';
import { AgentDeliveryController } from '../src/delivery/http/agent-delivery.controller.js';
import { AuthenticationService } from '../src/identity/application/authentication.service.js';
import { ActorGuard } from '../src/identity/http/actor.guard.js';

const actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', displayName: 'Agent', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [] } as const;
const vendorId = '00000000-0000-4000-8000-000000000003';
const routeStopId = '00000000-0000-4000-8000-000000000004';
const deliveryId = '00000000-0000-4000-8000-000000000005';
const service = {
  record: (_actor: unknown, _vendorId: string, currentRouteStopId: string, command: { serviceDate: string; outcome: 'delivered' }) => Promise.resolve({
    routeStopId: currentRouteStopId, serviceDate: command.serviceDate, outcome: command.outcome,
    items: [{ id: deliveryId, vendorId, householdId: 'household', subscriptionId: 'subscription', productId: 'product', unitId: 'unit', deliverySlotId: 'slot', routeAssignmentId: 'assignment', serviceDate: command.serviceDate, plannedQuantity: '1', actualQuantity: '1.25', currentStatus: 'delivered', version: 2, finalizedAt: new Date('2030-01-01T01:00:01Z') }],
  }),
};

@Module({
  controllers: [AgentDeliveryController],
  providers: [ActorGuard, { provide: RequestContextStore, useValue: requestContextStore }, { provide: AuthenticationService, useValue: { authenticate: () => Promise.resolve(actor) } }, { provide: AgentStopOutcomeService, useValue: service }],
})
class AgentOutcomeHttpTestModule {}

let app: INestApplication;
let baseUrl = '';
before(async () => {
  app = await NestFactory.create(AgentOutcomeHttpTestModule, { logger: false });
  app.setGlobalPrefix('v1');
  const context = new RequestContextMiddleware(requestContextStore, Buffer.alloc(32));
  app.use(context.use.bind(context));
  app.useGlobalFilters(new ApplicationErrorFilter(requestContextStore));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(() => app.close());

function post(body: unknown) {
  return fetch(`${baseUrl}/v1/agent/vendors/${vendorId}/route-stops/${routeStopId}/outcomes`, {
    method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

void test('agent stop outcome HTTP route returns the authoritative stop and rejects malformed unions', async () => {
  const valid = { serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T01:00:00Z', items: [{ scheduledDeliveryId: deliveryId, expectedVersion: 1, actualQuantity: '1.25' }] };
  const response = await post(valid);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    routeStopId, serviceDate: '2030-01-01', outcome: 'delivered',
    items: [{ id: deliveryId, householdId: 'household', subscriptionId: 'subscription', serviceDate: '2030-01-01', plannedQuantity: '1', actualQuantity: '1.25', currentStatus: 'delivered', version: 2, finalizedAt: '2030-01-01T01:00:01.000Z' }],
  });
  for (const body of [{ ...valid, unknown: true }, { ...valid, occurredAt: '2030-01-01T01:00:00' }, { ...valid, items: [] }]) {
    const invalid = await post(body);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { code: string }).code, 'INVALID_REQUEST');
  }
  for (const body of [
    { ...valid, items: [{ scheduledDeliveryId: deliveryId, expectedVersion: 1, actualQuantity: '0' }] },
    { ...valid, note: 'not allowed' },
    { ...valid, outcome: 'missed', reasonCode: 'access_blocked' },
  ]) {
    const invalid = await post(body);
    assert.equal(invalid.status, 400);
  }
});
