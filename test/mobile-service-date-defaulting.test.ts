import assert from 'node:assert/strict';
import test from 'node:test';

import { Settings } from 'luxon';

import type { Actor } from '../src/common/context/request-context.js';
import { DefaultPricingService } from '../src/pricing/application/pricing.service.js';
import { DefaultRouteService } from '../src/routing/application/route.service.js';
import { DefaultScheduledDeliveryService } from '../src/scheduling/application/scheduled-delivery.service.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Mobile user',
  authenticationMethod: 'phone_otp',
  platformRoles: [],
  memberships: [],
};
const vendorId = '00000000-0000-4000-8000-000000000003';
const authorization = { execute: (_input: unknown, work: (tx: object) => Promise<unknown>) => work({}) };

function routeService(timezone: string, observed: string[]) {
  return new DefaultRouteService(
    authorization as never,
    {} as never,
    {} as never,
    { listSelf: (_tx: unknown, _membershipId: string, serviceDate: string) => { observed.push(serviceDate); return Promise.resolve({ items: [] }); } } as never,
    {} as never,
    {} as never,
    { resolveSelfRouteAgent: () => Promise.resolve({ membershipId: '00000000-0000-4000-8000-000000000004' }) } as never,
    { getSubscriptionTimezone: () => Promise.resolve({ timezone }) } as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function scheduledService(timezone: string, observed: string[]) {
  const Constructor = DefaultScheduledDeliveryService as unknown as new (...args: unknown[]) => DefaultScheduledDeliveryService;
  return new Constructor(
    authorization,
    { resolveSelfRouteAgent: () => Promise.resolve({ membershipId: '00000000-0000-4000-8000-000000000004' }) },
    { listSelf: (_tx: unknown, _vendorId: string, _membershipId: string, serviceDate: string) => { observed.push(serviceDate); return Promise.resolve({ items: [] }); } },
    { getSubscriptionTimezone: () => Promise.resolve({ timezone }) },
  );
}

function pricingService(timezone: string, observed: Date[]) {
  return new DefaultPricingService(
    authorization as never,
    { resolveOverride: (_tx: unknown, _householdId: string, _productId: string, _unitId: string, at: Date) => { observed.push(at); return Promise.resolve(undefined); }, resolveGlobal: () => Promise.resolve(undefined) } as never,
    { requirePricingProduct: () => Promise.resolve(), getPricingDeliverySlotStart: () => Promise.resolve('06:00') } as never,
    { requireCustomerPricingHousehold: () => Promise.resolve() } as never,
    { getPricingSettings: () => Promise.resolve({ timezone, currency: 'INR' }) } as never,
    {} as never,
  );
}

void test('omitted mobile dates use the authenticated vendor local date and return it for empty or missing results', async () => {
  const previousNow = Settings.now;
  Settings.now = () => Date.parse('2026-07-20T00:30:00Z');
  try {
    const routeDates: string[] = [];
    const route = await routeService('America/Adak', routeDates).listSelfAssignments(actor, vendorId, {});
    assert.deepEqual(route, { serviceDate: '2026-07-19', items: [] });
    assert.deepEqual(routeDates, ['2026-07-19']);

    const deliveryDates: string[] = [];
    const deliveries = await scheduledService('America/Adak', deliveryDates).listSelf(actor, vendorId, undefined, {});
    assert.deepEqual(deliveries, { serviceDate: '2026-07-19', items: [] });
    assert.deepEqual(deliveryDates, ['2026-07-19']);

    const instants: Date[] = [];
    const price = await pricingService('America/Adak', instants).resolveCustomer(actor, vendorId, '00000000-0000-4000-8000-000000000005', {
      productId: '00000000-0000-4000-8000-000000000006',
      unitId: '00000000-0000-4000-8000-000000000007',
      deliverySlotId: '00000000-0000-4000-8000-000000000008',
    });
    assert.deepEqual(price, { serviceDate: '2026-07-19', status: 'missing' });
    assert.equal(instants.length, 1);
  } finally {
    Settings.now = previousNow;
  }
});

void test('explicit mobile dates pass through unchanged without consulting the default-date timezone', async () => {
  const expected = '2026-08-02';
  const routeDates: string[] = [];
  assert.equal((await routeService('Invalid/Timezone', routeDates).listSelfAssignments(actor, vendorId, { serviceDate: expected })).serviceDate, expected);
  assert.deepEqual(routeDates, [expected]);

  const deliveryDates: string[] = [];
  assert.equal((await scheduledService('Invalid/Timezone', deliveryDates).listSelf(actor, vendorId, expected, {})).serviceDate, expected);
  assert.deepEqual(deliveryDates, [expected]);

  const price = await pricingService('UTC', []).resolveCustomer(actor, vendorId, '00000000-0000-4000-8000-000000000005', {
    productId: '00000000-0000-4000-8000-000000000006',
    unitId: '00000000-0000-4000-8000-000000000007',
    deliverySlotId: '00000000-0000-4000-8000-000000000008',
    serviceDate: expected,
  });
  assert.equal(price.serviceDate, expected);
});

void test('invalid explicit mobile dates remain rejected', async () => {
  await assert.rejects(routeService('UTC', []).listSelfAssignments(actor, vendorId, { serviceDate: '2026-02-30' }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_ROUTE_DATE');
  await assert.rejects(scheduledService('UTC', []).listSelf(actor, vendorId, '2026-02-30', {}), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_SCHEDULE_DATE');
  await assert.rejects(pricingService('UTC', []).resolveCustomer(actor, vendorId, '00000000-0000-4000-8000-000000000005', {
    productId: '00000000-0000-4000-8000-000000000006', unitId: '00000000-0000-4000-8000-000000000007', deliverySlotId: '00000000-0000-4000-8000-000000000008', serviceDate: '2026-02-30',
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_SERVICE_DATE');
});

void test('vendor resolved pricing keeps its existing response shape', async () => {
  const service = new DefaultPricingService(
    authorization as never,
    {
      resolveOverride: () => Promise.resolve(undefined),
      resolveGlobal: () => Promise.resolve({ id: '00000000-0000-4000-8000-000000000009', amountMinor: '6500', currency: 'INR' }),
    } as never,
    { requirePricingProduct: () => Promise.resolve(), getPricingDeliverySlotStart: () => Promise.resolve('06:00') } as never,
    { requirePricingHousehold: () => Promise.resolve() } as never,
    { getPricingSettings: () => Promise.resolve({ timezone: 'UTC', currency: 'INR' }) } as never,
    {} as never,
  );
  const result = await service.resolveVendor(actor, vendorId, {
    householdId: '00000000-0000-4000-8000-000000000005',
    productId: '00000000-0000-4000-8000-000000000006',
    unitId: '00000000-0000-4000-8000-000000000007',
    deliverySlotId: '00000000-0000-4000-8000-000000000008',
    serviceDate: '2026-08-02',
  });
  assert.deepEqual(result, { status: 'resolved', amountMinor: '6500', currency: 'INR', source: 'global', sourcePriceId: '00000000-0000-4000-8000-000000000009' });
});
