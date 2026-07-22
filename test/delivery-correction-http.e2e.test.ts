import assert from 'node:assert/strict';
import test from 'node:test';

import { VendorDeliveryController } from '../src/delivery/http/vendor-delivery.controller.js';

void test('delivery correction remains a vendor-only append route', () => {
  const correct = Object.getOwnPropertyDescriptor(VendorDeliveryController.prototype, 'correct')?.value;
  assert.equal(Reflect.getMetadata('path', VendorDeliveryController), 'vendors/:vendorId/deliveries');
  assert.equal(Reflect.getMetadata('path', correct), ':deliveryId/correct');
  assert.equal(Reflect.getMetadata('method', correct), 1);
});
