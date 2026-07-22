import assert from 'node:assert/strict';
import test from 'node:test';

import { CustomerDeliveryController } from '../src/delivery/http/customer-delivery.controller.js';
import { VendorDeliveryController } from '../src/delivery/http/vendor-delivery.controller.js';

void test('delivery projections retain their frozen vendor and customer route namespaces', () => {
  assert.equal(Reflect.getMetadata('path', VendorDeliveryController), 'vendors/:vendorId/deliveries');
  assert.equal(Reflect.getMetadata('path', CustomerDeliveryController), 'customer/vendors/:vendorId/households/:householdId/deliveries');
});
