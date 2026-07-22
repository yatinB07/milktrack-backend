import assert from 'node:assert/strict';
import test from 'node:test';

import type { TenantAuthorizationInput } from '../src/authorization/application/tenant-authorization.executor.js';
import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import type { HouseholdService } from '../src/customers/application/household.service.js';
import { DeliveryQueryService } from '../src/delivery/application/delivery-query.service.js';
import type { DeliveryDetail, DeliveryStore } from '../src/delivery/application/delivery.store.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [],
  memberships: [{ id: '00000000-0000-4000-8000-000000000003', vendorId: '00000000-0000-4000-8000-000000000004', vendorName: 'Milk', role: 'customer', status: 'active' }],
};
const detail: DeliveryDetail = {
  id: '00000000-0000-4000-8000-000000000005', vendorId: '00000000-0000-4000-8000-000000000004',
  householdId: '00000000-0000-4000-8000-000000000006', subscriptionId: '00000000-0000-4000-8000-000000000007',
  productId: '00000000-0000-4000-8000-000000000008', unitId: '00000000-0000-4000-8000-000000000009',
  deliverySlotId: '00000000-0000-4000-8000-000000000010', serviceDate: '2030-01-01', plannedQuantity: '1',
  currentStatus: 'delivered', version: 2, finalizedAt: new Date('2030-01-01T06:00:00.000Z'),
  events: [],
};

void test('delivery query service scopes vendor monitor filters through schedule read authorization', async () => {
  const requests: TenantAuthorizationInput[] = [];
  let query: unknown;
  const tx = {} as TransactionContext;
  const service = new DeliveryQueryService(
    { execute: (input: TenantAuthorizationInput, work: (context: TransactionContext) => Promise<unknown>) => { requests.push(input); return work(tx); } } as never,
    { listVendor: (_tx: TransactionContext, value: unknown) => { query = value; return Promise.resolve({ items: [detail] }); } } as unknown as DeliveryStore,
    {} as HouseholdService,
  );

  const page = await service.listVendor({ ...actor, authenticationMethod: 'administrator_mfa' }, detail.vendorId, {
    serviceDate: detail.serviceDate, householdId: detail.householdId, routeId: '00000000-0000-4000-8000-000000000011',
    agentMembershipId: '00000000-0000-4000-8000-000000000012', productId: detail.productId, currentStatus: 'delivered', limit: 100,
  });

  assert.deepEqual(requests.map(({ permission, operation }) => ({ permission, operation })), [{ permission: 'schedule:read', operation: 'delivery.list' }]);
  assert.deepEqual(query, { vendorId: detail.vendorId, serviceDate: detail.serviceDate, householdId: detail.householdId, routeId: '00000000-0000-4000-8000-000000000011', agentMembershipId: '00000000-0000-4000-8000-000000000012', productId: detail.productId, currentStatus: 'delivered', limit: 100 });
  assert.deepEqual(page.items, [detail]);
});

void test('delivery query service authorizes the customer household before the customer store projection', async () => {
  const calls: string[] = [];
  const requests: TenantAuthorizationInput[] = [];
  const tx = {} as TransactionContext;
  const service = new DeliveryQueryService(
    { execute: (input: TenantAuthorizationInput, work: (context: TransactionContext) => Promise<unknown>) => { requests.push(input); return work(tx); } } as never,
    { getCustomerDetail: (_tx: TransactionContext, vendorId: string, householdId: string, id: string) => { calls.push(`store:${vendorId}:${householdId}:${id}`); return Promise.resolve(detail); } } as unknown as DeliveryStore,
    { requireCustomerSubscriptionHousehold: (_tx: TransactionContext, current: Actor, vendorId: string, householdId: string) => { assert.equal(current, actor); calls.push(`household:${vendorId}:${householdId}`); return Promise.resolve({ householdId }); } } as unknown as HouseholdService,
  );

  assert.equal((await service.getCustomerDetail(actor, detail.vendorId, detail.householdId, detail.id)).id, detail.id);
  assert.deepEqual(requests.map(({ permission, operation }) => ({ permission, operation })), [{ permission: 'customer:self', operation: 'delivery.self-get' }]);
  assert.deepEqual(calls, [`household:${detail.vendorId}:${detail.householdId}`, `store:${detail.vendorId}:${detail.householdId}:${detail.id}`]);
});

void test('delivery query service uses distinct detail and customer list operations', async () => {
  const requests: TenantAuthorizationInput[] = [];
  const tx = {} as TransactionContext;
  const service = new DeliveryQueryService(
    { execute: (input: TenantAuthorizationInput, work: (context: TransactionContext) => Promise<unknown>) => { requests.push(input); return work(tx); } } as never,
    {
      getVendorDetail: () => Promise.resolve(detail),
      listCustomer: () => Promise.resolve({ items: [detail] }),
    } as unknown as DeliveryStore,
    { requireCustomerSubscriptionHousehold: () => Promise.resolve({ householdId: detail.householdId }) } as unknown as HouseholdService,
  );

  await service.getVendorDetail({ ...actor, authenticationMethod: 'administrator_mfa' }, detail.vendorId, detail.id);
  await service.listCustomer(actor, detail.vendorId, detail.householdId, {});

  assert.deepEqual(requests.map(({ permission, operation }) => ({ permission, operation })), [
    { permission: 'schedule:read', operation: 'delivery.get' },
    { permission: 'customer:self', operation: 'delivery.self-list' },
  ]);
});
