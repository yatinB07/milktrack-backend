import assert from 'node:assert/strict';
import test from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { AuditWriter } from '../src/audit/application/audit-writer.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { DeliveryPolicyController } from '../src/vendors/http/delivery-policy.controller.js';
import { toDeliveryPolicyResponse, UpdateDeliveryPolicyRequestDto } from '../src/vendors/http/delivery-policy.dto.js';
import { PrismaVendorService, type VendorService } from '../src/vendors/application/vendor.service.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Vendor owner',
  authenticationMethod: 'administrator_mfa',
  platformRoles: [],
  memberships: [],
};
const vendorId = '00000000-0000-4000-8000-000000000010';
const policy = { vendorId, skipCutoffMinutes: 60, lateLeavePolicy: 'approval' as const, captureAgentLocationEvidence: false, version: 4 };

void test('delivery policy controller maps the explicit policy response', async () => {
  const service = {
    getDeliveryPolicy: () => Promise.resolve(policy),
    updateDeliveryPolicy: () => Promise.resolve({ ...policy, skipCutoffMinutes: 90, lateLeavePolicy: 'reject' as const, captureAgentLocationEvidence: true, version: 5 }),
  } as unknown as VendorService;
  const controller = new DeliveryPolicyController(service);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003', actor }, async () => {
    assert.deepEqual(await controller.get(vendorId), policy);
    assert.deepEqual(await controller.update(vendorId, {
      skipCutoffMinutes: 90, lateLeavePolicy: 'reject', captureAgentLocationEvidence: true, expectedVersion: 4, reason: 'Align cutoff with dispatch',
    }), { ...policy, skipCutoffMinutes: 90, lateLeavePolicy: 'reject', captureAgentLocationEvidence: true, version: 5 });
  });
  assert.deepEqual(toDeliveryPolicyResponse({ ...policy, secret: 'do-not-return' } as typeof policy), policy);
});

void test('delivery policy reason is trimmed before validating its bounds', async () => {
  const value = (reason: string) => plainToInstance(UpdateDeliveryPolicyRequestDto, {
    skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, expectedVersion: 4, reason,
  });
  const accepted = value(`  ${'x'.repeat(500)}  `);
  assert.equal((await validate(accepted)).length, 0);
  assert.equal(accepted.reason, 'x'.repeat(500));
  const minimum = value('  abc  ');
  assert.equal((await validate(minimum)).length, 0);
  assert.equal(minimum.reason, 'abc');
  assert.notEqual((await validate(value('   '))).length, 0);
  assert.notEqual((await validate(value('x'.repeat(501)))).length, 0);
});

void test('delivery policy update uses expected version and audits safe values', async () => {
  const tx = {} as TransactionContext;
  const audits: unknown[] = [];
  const auditWriter: Pick<AuditWriter, 'append'> = { append: (_tx, event) => { audits.push(event); return Promise.resolve(); } };
  const store = {
    getDeliveryPolicy: () => Promise.resolve(policy),
    updateDeliveryPolicy: (_tx: TransactionContext, _vendorId: string, command: unknown) => Promise.resolve({ previous: policy, updated: { ...policy, ...(command as object), version: 5 } }),
  };
  const service = new PrismaVendorService(
    {} as never,
    {} as never,
    { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) } as never,
    store as never,
    auditWriter,
    {} as never,
  );
  const result = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000003' },
    () => service.updateDeliveryPolicy(actor, vendorId, {
      skipCutoffMinutes: 90,
      lateLeavePolicy: 'reject',
      captureAgentLocationEvidence: true,
      expectedVersion: 4,
      reason: 'Align cutoff with dispatch',
    }),
  );
  assert.equal(result.version, 5);
  assert.deepEqual(audits[0], {
    id: (audits[0] as { id: string }).id,
    vendorId,
    actorUserId: actor.userId,
    action: 'vendor.delivery_policy.updated',
    entityType: 'vendor',
    entityId: vendorId,
    oldValue: { skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 4 },
    newValue: { skipCutoffMinutes: 90, lateLeavePolicy: 'reject', captureAgentLocationEvidence: true, version: 5 },
    reason: 'Align cutoff with dispatch',
    correlationId: '00000000-0000-4000-8000-000000000003',
  });
});

void test('transaction-bound policy read delegates without a second authorization transaction', async () => {
  const transaction = {} as TransactionContext;
  const service = new PrismaVendorService(
    {} as never, {} as never, {} as never,
    { getDeliveryPolicy: (current: TransactionContext, currentVendorId: string) => { assert.equal(current, transaction); assert.equal(currentVendorId, vendorId); return Promise.resolve(policy); } } as never,
    {} as never, {} as never,
  );
  assert.deepEqual(await service.getDeliveryPolicyForTransaction(transaction, vendorId), policy);
});

void test('delivery policy read uses its Phase 3 authorization operation', async () => {
  let authorizationInput: unknown;
  const transaction = {} as TransactionContext;
  const service = new PrismaVendorService(
    {} as never,
    {} as never,
    {
      execute: (input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => {
        authorizationInput = input;
        return operation(transaction);
      },
    } as never,
    { getDeliveryPolicy: () => Promise.resolve(policy) } as never,
    {} as never,
    {} as never,
  );

  assert.deepEqual(await service.getDeliveryPolicy(actor, vendorId), policy);
  assert.deepEqual(authorizationInput, {
    actor,
    vendorId,
    permission: 'vendor:profile:read',
    operation: 'vendor.delivery-policy.read',
  });
});

void test('delivery policy audit uses the exact state locked by the update', async () => {
  const tx = {} as TransactionContext;
  const events: Parameters<AuditWriter['append']>[1][] = [];
  const concurrent = { ...policy, skipCutoffMinutes: 75, version: 5 };
  const updated = { ...concurrent, skipCutoffMinutes: 90, lateLeavePolicy: 'reject' as const, captureAgentLocationEvidence: true, version: 6 };
  const service = new PrismaVendorService(
    {} as never, {} as never,
    { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) } as never,
    {
      getDeliveryPolicy: () => Promise.resolve(policy),
      updateDeliveryPolicy: () => Promise.resolve({ previous: concurrent, updated }),
    } as never,
    { append: (_tx, event) => { events.push(event); return Promise.resolve(); } }, {} as never,
  );
  const result = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000003' },
    () => service.updateDeliveryPolicy(actor, vendorId, { skipCutoffMinutes: 90, lateLeavePolicy: 'reject', captureAgentLocationEvidence: true, expectedVersion: 5, reason: ' Interleaved update ' }),
  );
  assert.deepEqual(result, updated);
  assert.deepEqual(events[0]?.oldValue, { skipCutoffMinutes: 75, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 5 });
  assert.equal(events[0]?.reason, 'Interleaved update');
});
