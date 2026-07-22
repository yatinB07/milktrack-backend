import assert from 'node:assert/strict';
import test from 'node:test';

import { validate } from 'class-validator';

import { requestContextStore } from '../src/common/context/request-context.js';
import { DefaultPricingService } from '../src/pricing/application/pricing.service.js';
import {
  CustomerResolvedPriceResponseDto,
  ResolveCustomerPriceQueryDto,
} from '../src/pricing/http/pricing.dto.js';
import { CustomerResolvedPriceController } from '../src/pricing/http/resolved-price.controller.js';
import { AgentRouteAssignmentQueryDto } from '../src/routing/http/route.dto.js';
import { AgentScheduledDeliveryQueryDto } from '../src/scheduling/http/scheduled-delivery.dto.js';

void test('customer price date is required input and required response metadata', async () => {
  const query = Object.assign(new ResolveCustomerPriceQueryDto(), {
    productId: '00000000-0000-4000-8000-000000000001',
    unitId: '00000000-0000-4000-8000-000000000002',
    deliverySlotId: '00000000-0000-4000-8000-000000000003',
    serviceDate: '2026-07-20',
  });

  assert.deepEqual(await validate(query), []);
  assert.ok(
    (Reflect.getMetadata('swagger/apiModelPropertiesArray', CustomerResolvedPriceResponseDto.prototype) as string[])
      .includes(':serviceDate'),
  );
});

void test('customer price rejects malformed calendar-date shapes', async () => {
  const query = Object.assign(new ResolveCustomerPriceQueryDto(), {
    productId: '00000000-0000-4000-8000-000000000001',
    unitId: '00000000-0000-4000-8000-000000000002',
    deliverySlotId: '00000000-0000-4000-8000-000000000003',
    serviceDate: '2026-7-2',
  });
  assert.equal((await validate(query)).some(({ constraints }) => constraints?.matches !== undefined), true);
});

void test('agent mobile date queries reject malformed calendar-date shapes', async () => {
  for (const Query of [AgentRouteAssignmentQueryDto, AgentScheduledDeliveryQueryDto]) {
    const query = Object.assign(new Query(), { serviceDate: '2026-7-2' });
    assert.equal((await validate(query)).some(({ constraints }) => constraints?.matches !== undefined), true);
  }
});

void test('customer resolved-price service response includes the requested service date', async () => {
  const service = new DefaultPricingService(
    { execute: (_input: unknown, work: (tx: object) => Promise<unknown>) => work({}) } as never,
    { resolveOverride: () => Promise.resolve(undefined), resolveGlobal: () => Promise.resolve(undefined) } as never,
    { requirePricingProduct: () => Promise.resolve(), getPricingDeliverySlotStart: () => Promise.resolve('06:00') } as never,
    { requireCustomerPricingHousehold: () => Promise.resolve() } as never,
    { getPricingSettings: () => Promise.resolve({ timezone: 'Asia/Kolkata', currency: 'INR' }) } as never,
    {} as never,
  );
  const controller = new CustomerResolvedPriceController(service);
  const query = Object.assign(new ResolveCustomerPriceQueryDto(), {
    productId: '00000000-0000-4000-8000-000000000001',
    unitId: '00000000-0000-4000-8000-000000000002',
    deliverySlotId: '00000000-0000-4000-8000-000000000003',
    serviceDate: '2026-07-20',
  });
  const actor = { userId: '00000000-0000-4000-8000-000000000004', sessionId: '00000000-0000-4000-8000-000000000005', displayName: 'Customer', authenticationMethod: 'phone_otp' as const, platformRoles: [], memberships: [] };
  const response = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000006', actor }, () => controller.resolve('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000008', query));
  assert.deepEqual(response, { serviceDate: query.serviceDate, status: 'missing' });
});
