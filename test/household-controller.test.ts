import assert from 'node:assert/strict';
import test from 'node:test';

import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import type { HouseholdService } from '../src/customers/application/household.service.js';
import { HouseholdController } from '../src/customers/http/household.controller.js';

const actor: Actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', displayName: 'Owner', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] };
const household = { id: '00000000-0000-4000-8000-000000000003', vendorId: '00000000-0000-4000-8000-000000000004', accountNumber: 'HH-1', name: 'Household', addressLine1: 'Road', city: 'City', region: 'Region', postalCode: '12345', countryCode: 'IN', status: 'active' as const, version: 1, createdAt: new Date('2026-07-20T00:00:00Z'), updatedAt: new Date('2026-07-20T00:00:00Z') };

void test('household controller maps the service result to an explicit public response', async () => {
  const controller = new HouseholdController({ create: () => Promise.resolve(household) } as unknown as HouseholdService);
  const response = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000005', actor }, () => controller.create(household.vendorId, household));
  assert.deepEqual(response, { ...household, createdAt: household.createdAt.toISOString(), updatedAt: household.updatedAt.toISOString() });
});
