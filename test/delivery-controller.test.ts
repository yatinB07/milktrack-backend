import assert from 'node:assert/strict';
import test from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { CustomerDeliveryController } from '../src/delivery/http/customer-delivery.controller.js';
import { VendorDeliveryController } from '../src/delivery/http/vendor-delivery.controller.js';
import { VendorDeliveryPageQueryDto } from '../src/delivery/http/delivery.dto.js';

const actor: Actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', displayName: 'Owner', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] };
const record = {
  id: '00000000-0000-4000-8000-000000000003', vendorId: '00000000-0000-4000-8000-000000000004', householdId: '00000000-0000-4000-8000-000000000005', subscriptionId: '00000000-0000-4000-8000-000000000006', productId: '00000000-0000-4000-8000-000000000007', unitId: '00000000-0000-4000-8000-000000000008', deliverySlotId: '00000000-0000-4000-8000-000000000009', routeAssignmentId: '00000000-0000-4000-8000-000000000010', serviceDate: '2030-01-01', plannedQuantity: '1', actualQuantity: '1', currentStatus: 'delivered' as const, version: 2, finalizedAt: new Date('2030-01-01T06:00:00.000Z'),
  events: [{ id: '00000000-0000-4000-8000-000000000011', eventType: 'delivered' as const, source: 'delivery_agent' as const, occurredAt: new Date('2030-01-01T06:00:00.000Z'), receivedAt: new Date('2030-01-01T06:00:01.000Z'), createdAt: new Date('2030-01-01T06:00:02.000Z'), actualQuantity: '1', reasonCode: 'customer_unavailable', note: 'Corrected', replacedEventId: '00000000-0000-4000-8000-000000000012', latitude: '18.5204', longitude: '73.8567' }],
  snapshot: { amountMinor: '6500', currency: 'INR', pricingLevel: 'customer_specific' as const, sourcePriceId: '00000000-0000-4000-8000-000000000013', sourcePriceType: 'customer_price_override' as const, resolvedAt: new Date('2030-01-01T05:00:00.000Z') },
};

void test('delivery controllers use explicit safe response mappings and retain GPS only in vendor detail', async () => {
  const service = { listVendor: () => Promise.resolve({ items: [record] }), getVendorDetail: () => Promise.resolve(record), listCustomer: () => Promise.resolve({ items: [record] }), getCustomerDetail: () => Promise.resolve(record) };
  const vendor = new VendorDeliveryController(service as never);
  const customer = new CustomerDeliveryController(service as never);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000014', actor }, async () => {
    const vendorList = await vendor.list(record.vendorId, new VendorDeliveryPageQueryDto());
    assert.deepEqual(Object.keys(vendorList.items[0] ?? {}).sort(), ['currentStatus', 'finalizedAt', 'householdId', 'id', 'plannedQuantity', 'serviceDate', 'subscriptionId', 'version']);
    const vendorDetail = await vendor.get(record.vendorId, record.id);
    assert.equal(vendorDetail.events[0]?.latitude, record.events[0].latitude);
    const customerDetail = await customer.get(record.vendorId, record.householdId, record.id);
    assert.equal('latitude' in (customerDetail.events[0] ?? {}), false);
    assert.equal('longitude' in (customerDetail.events[0] ?? {}), false);
    assert.equal(customerDetail.events[0]?.source, 'delivery_agent');
    assert.equal(customerDetail.events[0]?.reasonCode, 'customer_unavailable');
    assert.equal(customerDetail.events[0]?.replacedEventId, record.events[0].replacedEventId);
    assert.equal(customerDetail.snapshot?.amountMinor, '6500');
  });
});

void test('delivery pagination DTO transforms and bounds the limit', async () => {
  const query = plainToInstance(VendorDeliveryPageQueryDto, { limit: '101' });
  const errors = await validate(query);
  assert.equal(query.limit, 101);
  assert.equal(errors.some(({ property }) => property === 'limit'), true);
});
