import assert from 'node:assert/strict';
import test from 'node:test';

import type { AuditWriter } from '../src/audit/application/audit-writer.js';
import type { TenantAuthorizationExecutor } from '../src/authorization/application/tenant-authorization.executor.js';
import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import type { VendorService } from '../src/vendors/application/vendor.service.js';
import {
  DefaultScheduleGenerationRunService,
} from '../src/scheduling/application/schedule-generation-run.service.js';
import type { ScheduleGenerationRunStore } from '../src/scheduling/application/schedule-generation-run.store.js';
import type { ScheduleRunProcessor } from '../src/scheduling/application/schedule-run-processor.js';
import { ScheduleGenerationRunController } from '../src/scheduling/http/schedule-generation-run.controller.js';

const vendorId = '00000000-0000-4000-8000-000000000010';
const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Schedule administrator',
  authenticationMethod: 'administrator_mfa',
  platformRoles: [],
  memberships: [],
};

const run = {
  id: '00000000-0000-4000-8000-000000000011',
  vendorId,
  trigger: 'manual' as const,
  triggerLocalDate: '2026-07-20',
  serviceDate: '2026-07-21',
  status: 'succeeded' as const,
  attempt: 1,
  maxAttempts: 5,
  availableAt: new Date('2026-07-20T00:00:00.000Z'),
  startedAt: new Date('2026-07-20T00:00:00.000Z'),
  finishedAt: new Date('2026-07-20T00:00:01.000Z'),
  counts: { created: 1, existing: 2, updated: 3, cancelled: 4, missingPrice: 5 },
  createdAt: new Date('2026-07-20T00:00:00.000Z'),
  updatedAt: new Date('2026-07-20T00:00:01.000Z'),
};

function service(input: Readonly<{ processor?: ScheduleRunProcessor; store?: ScheduleGenerationRunStore; audits?: AuditWriter }> = {}) {
  const authorization: TenantAuthorizationExecutor = {
    execute: async (_input, operation) => operation({} as never),
  };
  const vendors: VendorService = {
    getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }),
  } as unknown as VendorService;
  const store = input.store ?? {
    createAndClaimManual: () => Promise.resolve({
      id: run.id, vendorId, trigger: 'manual' as const, triggerLocalDate: run.triggerLocalDate,
      serviceDate: run.serviceDate, attempt: 1, maxAttempts: 5,
      leaseToken: '00000000-0000-4000-8000-000000000012', leaseExpiresAt: new Date(),
      requestedByUserId: actor.userId,
    }),
    list: () => Promise.resolve({ items: [run] }),
  } as unknown as ScheduleGenerationRunStore;
  const processor: ScheduleRunProcessor = input.processor ?? { process: () => Promise.resolve(run) };
  const audits: AuditWriter = input.audits ?? { append: () => Promise.resolve() };
  return new DefaultScheduleGenerationRunService(authorization, vendors, store, processor, audits);
}

void test('manual generation claims a running run, audits it, and processes that exact claim', async () => {
  const calls: string[] = [];
  const store = {
    createAndClaimManual: (_tx: never, input: { serviceDate: string; requestedByUserId: string }) => {
      calls.push(`claim:${input.serviceDate}:${input.requestedByUserId}`);
      return Promise.resolve({
        id: run.id, vendorId, trigger: 'manual' as const, triggerLocalDate: run.triggerLocalDate,
        serviceDate: input.serviceDate, attempt: 1, maxAttempts: 5,
        leaseToken: '00000000-0000-4000-8000-000000000012', leaseExpiresAt: new Date(),
        requestedByUserId: input.requestedByUserId,
      });
    },
  } as unknown as ScheduleGenerationRunStore;
  const processor: ScheduleRunProcessor = { process: (claim) => { calls.push(`process:${claim.id}`); return Promise.resolve(run); } };
  const audits: AuditWriter = { append: (_tx, event) => { calls.push(`audit:${event.action}:${event.entityId}`); return Promise.resolve(); } };

  const result = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003', actor }, () =>
    service({ store, processor, audits }).generateManual(actor, vendorId, { serviceDate: run.serviceDate }),
  );

  assert.equal(result, run);
  assert.deepEqual(calls, [
    `claim:${run.serviceDate}:${actor.userId}`,
    `audit:schedule_generation.manual_requested:${run.id}`,
    `process:${run.id}`,
  ]);
});

void test('manual generation accepts only the vendor-local rolling seven-day horizon', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const yesterday = new Date(`${today}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const serviceDate = yesterday.toISOString().slice(0, 10);

  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003', actor }, async () =>
    assert.rejects(
      service().generateManual(actor, vendorId, { serviceDate }),
      (error: unknown) => error instanceof ApplicationError && error.code === 'INVALID_SCHEDULE_DATE' && error.status === 400,
    ),
  );
});

void test('manual processor failure exposes only a retryable safe run identity', async () => {
  const processor: ScheduleRunProcessor = { process: () => Promise.reject(new Error('database password should not escape')) };

  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003', actor }, async () =>
    assert.rejects(
      service({ processor }).generateManual(actor, vendorId, { serviceDate: run.serviceDate }),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === 'SCHEDULE_GENERATION_FAILED' &&
        error.status === 503 && error.retryable && error.runId === run.id &&
        !error.message.includes('password'),
    ),
  );
});

void test('run list uses schedule read authorization and preserves filters plus tied cursor page', async () => {
  let authorizationInput: unknown;
  let storeQuery: unknown;
  const authorization: TenantAuthorizationExecutor = {
    execute: async (input, operation) => { authorizationInput = input; return operation({} as never); },
  };
  const store = { list: (_tx: never, _vendorId: string, query: unknown) => { storeQuery = query; return Promise.resolve({ items: [run], nextCursor: 'next' }); } } as unknown as ScheduleGenerationRunStore;
  const instance = new DefaultScheduleGenerationRunService(
    authorization,
    { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }) } as unknown as VendorService,
    store,
    { process: () => Promise.resolve(run) },
    { append: () => Promise.resolve() },
  );

  const page = await instance.list(actor, vendorId, { trigger: 'manual', status: 'failed', serviceDate: run.serviceDate, cursor: 'tied', limit: 25 });

  assert.deepEqual(authorizationInput, { actor, vendorId, permission: 'schedule:read', operation: 'schedule.run-list' });
  assert.deepEqual(storeQuery, { trigger: 'manual', status: 'failed', serviceDate: run.serviceDate, cursor: 'tied', limit: 25 });
  assert.deepEqual(page, { items: [run], nextCursor: 'next' });
});

void test('controller maps manual and list responses without persistence types', async () => {
  const scheduled = {
    generateManual: () => Promise.resolve(run),
    list: () => Promise.resolve({ items: [run], nextCursor: 'next' }),
  } as unknown as DefaultScheduleGenerationRunService;
  const controller = new ScheduleGenerationRunController(scheduled);

  const response = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003', actor }, () =>
    controller.manual(vendorId, { serviceDate: run.serviceDate }),
  );
  const page = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003', actor }, () =>
    controller.list(vendorId, { limit: 25 }),
  );

  const safeRun = Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'vendorId'));
  assert.deepEqual(response, { ...safeRun, availableAt: run.availableAt.toISOString(), startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt.toISOString(), createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString() });
  assert.deepEqual(page, { items: [response], nextCursor: 'next' });
});
