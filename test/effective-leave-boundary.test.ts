import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { DefaultEffectiveLeaveService } from '../src/leave/application/effective-leave.service.js';
import { EffectiveLeaveService } from '../src/leave/application/effective-leave.service.js';
import { LeaveModule } from '../src/leave/leave.module.js';

void test('effective leave boundary delegates the occurrence key within the caller transaction', async () => {
  const tx = {} as TransactionContext;
  const key = {
    vendorId: '00000000-0000-4000-8000-000000000001',
    subscriptionId: '00000000-0000-4000-8000-000000000002',
    deliverySlotId: '00000000-0000-4000-8000-000000000003',
    serviceDate: '2030-01-01',
  };
  const calls: unknown[][] = [];
  const service = new DefaultEffectiveLeaveService({
    isEffectivelyOnLeave: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(true);
    },
  } as never);

  assert.equal(await service.isEffectivelyOnLeave(tx, key), true);
  assert.deepEqual(calls, [[tx, key]]);
});

void test('leave module exports the effective leave boundary', () => {
  const providers = Reflect.getMetadata('providers', LeaveModule) as readonly unknown[];
  const exports = Reflect.getMetadata('exports', LeaveModule) as readonly unknown[];
  assert.ok(providers.includes(DefaultEffectiveLeaveService));
  assert.ok(exports.includes(EffectiveLeaveService));
});
