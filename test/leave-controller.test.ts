import assert from 'node:assert/strict';
import test from 'node:test';

import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { CustomerLeaveController } from '../src/leave/http/customer-leave.controller.js';
import { VendorLeaveController } from '../src/leave/http/vendor-leave.controller.js';
import { toLeaveRequestResponse } from '../src/leave/http/leave.dto.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [],
};
const vendorId = '00000000-0000-4000-8000-000000000010';
const householdId = '00000000-0000-4000-8000-000000000011';
const requestId = '00000000-0000-4000-8000-000000000012';

void test('customer and vendor leave controllers map safe currentStatus responses', async () => {
  const unsafe = { id: requestId, vendorId, householdId, currentStatus: 'accepted' as const, version: 1, createdAt: new Date('2030-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-01T00:00:00.000Z'), revisions: [{ id: '00000000-0000-4000-8000-000000000013', action: 'create' as const, startDate: '2030-01-02', endDate: '2030-01-03', source: 'customer' as const, createdBy: actor.userId, status: 'accepted' as const, createdAt: new Date('2030-01-01T00:00:00.000Z'), subscriptionIds: [], auditPayload: { private: true } }] };
  const service = { getCustomer: () => Promise.resolve(unsafe), getVendorRequest: () => Promise.resolve(unsafe) };
  const customer = new CustomerLeaveController(service as never);
  const vendor = new VendorLeaveController(service as never);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000099', actor }, async () => {
    assert.equal((await customer.get(vendorId, householdId, requestId)).currentStatus, 'accepted');
    assert.equal((await vendor.getRequest(vendorId, requestId)).currentStatus, 'accepted');
  });
  const mapped = toLeaveRequestResponse(unsafe);
  const revision = mapped.revisions[0];
  assert.ok(revision);
  assert.equal('status' in mapped, false);
  assert.equal('createdBy' in revision, false);
  assert.equal('auditPayload' in revision, false);
});
