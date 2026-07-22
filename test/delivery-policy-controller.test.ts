import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { AuditWriter } from '../src/audit/application/audit-writer.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { DeliveryPolicyController } from '../src/vendors/http/delivery-policy.controller.js';
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
});

void test('delivery policy update uses expected version and audits safe values', async () => {
  const tx = {} as TransactionContext;
  const audits: unknown[] = [];
  const auditWriter: Pick<AuditWriter, 'append'> = { append: (_tx, event) => { audits.push(event); return Promise.resolve(); } };
  const store = {
    getDeliveryPolicy: () => Promise.resolve(policy),
    updateDeliveryPolicy: (_tx: TransactionContext, _vendorId: string, command: unknown) => Promise.resolve({ ...policy, ...(command as object), version: 5 }),
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
