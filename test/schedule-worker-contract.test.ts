import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import {
  ScheduleGenerationRunStore,
  type SeedAutomaticScheduleRuns,
} from '../src/scheduling/application/schedule-generation-run.store.js';
import {
  SCHEDULE_WORKER_OPTIONS,
  ScheduleWorker,
  type ScheduleWorkerOptions,
} from '../src/scheduling/application/schedule-worker.js';
import { SCHEDULE_GENERATION_HEARTBEAT_SECONDS } from '../src/scheduling/domain/schedule-generation-run.js';
import {
  type SchedulableVendor,
  type SchedulableVendorPage,
  SchedulingVendorService,
} from '../src/vendors/application/scheduling-vendor.service.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;

const frozenTypes: readonly [
  Expect<Equal<SchedulableVendor, Readonly<{ id: string; timezone: string }>>>,
  Expect<Equal<SchedulableVendorPage, Readonly<{
    items: readonly SchedulableVendor[];
    nextCursor?: string;
  }>>>,
  Expect<Equal<
    SchedulingVendorService['listEligible'],
    (input: Readonly<{ cursor?: string; limit: number }>) => Promise<SchedulableVendorPage>
  >>,
  Expect<Equal<
    SchedulingVendorService['findEligible'],
    (transaction: TransactionContext, vendorId: string) => Promise<SchedulableVendor | null>
  >>,
  Expect<Equal<SeedAutomaticScheduleRuns, Readonly<{
    vendorId: string;
    triggerLocalDate: string;
    serviceDates: readonly string[];
    now: Date;
  }>>>,
  Expect<Equal<
    ScheduleGenerationRunStore['seedAutomatic'],
    (transaction: TransactionContext, input: SeedAutomaticScheduleRuns) => Promise<number>
  >>,
  Expect<Equal<ScheduleWorkerOptions, Readonly<{
    pollIntervalMs: number;
    concurrency: number;
    heartbeatIntervalMs: number;
    shutdownTimeoutMs: number;
  }>>>,
  Expect<Equal<ScheduleWorker['run'], (signal: AbortSignal) => Promise<void>>>,
] = [true, true, true, true, true, true, true, true];

void test('publishes only the frozen S3 schedule worker contracts', () => {
  assert.deepEqual(frozenTypes, [true, true, true, true, true, true, true, true]);
  assert.equal(typeof SchedulingVendorService, 'function');
  assert.equal(typeof ScheduleGenerationRunStore, 'function');
  assert.equal(typeof ScheduleWorker, 'function');
  assert.equal(typeof SCHEDULE_WORKER_OPTIONS, 'symbol');
  assert.equal(SCHEDULE_WORKER_OPTIONS.description, 'SCHEDULE_WORKER_OPTIONS');
  assert.equal(SCHEDULE_GENERATION_HEARTBEAT_SECONDS, 20);
});
