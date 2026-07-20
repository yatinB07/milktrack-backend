import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { DateTime } from 'luxon';

import {
  TenantTransactionRunner,
  type TransactionContext,
} from '../src/common/application/transaction-context.js';
import { ScheduleGenerationRunStore } from '../src/scheduling/application/schedule-generation-run.store.js';
import { ScheduleRunProcessor } from '../src/scheduling/application/schedule-run-processor.js';
import { DefaultScheduleWorker } from '../src/scheduling/application/default-schedule-worker.js';
import type {
  ScheduleGenerationRun,
  ScheduleGenerationRunClaim,
} from '../src/scheduling/domain/schedule-generation-run.js';
import { SchedulingVendorService } from '../src/vendors/application/scheduling-vendor.service.js';

const vendorId = '10000000-0000-4000-8000-000000000001';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function claim(index: number): ScheduleGenerationRunClaim {
  return {
    id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    vendorId,
    trigger: 'automatic',
    triggerLocalDate: '2030-01-01',
    serviceDate: `2030-01-${String(index).padStart(2, '0')}`,
    attempt: 1,
    maxAttempts: 5,
    leaseToken: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    leaseExpiresAt: new Date('2030-01-01T00:01:00.000Z'),
  };
}

function completed(value: ScheduleGenerationRunClaim): ScheduleGenerationRun {
  return {
    ...value,
    status: 'succeeded',
    availableAt: new Date('2030-01-01T00:00:00.000Z'),
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    updatedAt: new Date('2030-01-01T00:00:01.000Z'),
  };
}

function runStore(overrides: Partial<ScheduleGenerationRunStore>): ScheduleGenerationRunStore {
  return {
    seedAutomatic: () => Promise.resolve(0),
    createAndClaimManual: () => Promise.reject(new Error('unused')),
    claimNext: () => Promise.resolve(null),
    renew: () => Promise.resolve(true),
    succeed: () => Promise.reject(new Error('unused')),
    fail: () => Promise.reject(new Error('unused')),
    list: () => Promise.reject(new Error('unused')),
    ...overrides,
  };
}

class RecordingTransactions extends TenantTransactionRunner {
  readonly contexts: TransactionContext[] = [];
  readonly committed: string[] = [];
  private readonly effects = new WeakMap<TransactionContext, string[]>();

  stage(context: TransactionContext, effect: string) {
    this.effects.get(context)!.push(effect);
  }

  async run<T>(_vendorId: string, operation: (context: TransactionContext) => Promise<T>) {
    const context = Object.freeze({}) as TransactionContext;
    this.contexts.push(context);
    this.effects.set(context, []);
    const result = await operation(context);
    this.committed.push(...this.effects.get(context)!);
    return result;
  }
}

const options = {
  pollIntervalMs: 10_000,
  concurrency: 2,
  heartbeatIntervalMs: 10_000,
  shutdownTimeoutMs: 100,
};

void test('pages and revalidates vendors, seeds their local seven-day horizon, and drains due work with bounded concurrency', async () => {
  const controller = new AbortController();
  const transactions = new RecordingTransactions();
  const listCalls: Array<Readonly<{ cursor?: string; limit: number }>> = [];
  const staleVendorId = '10000000-0000-4000-8000-000000000002';
  const vendors: SchedulingVendorService = {
    listEligible: (input) => {
      listCalls.push(input);
      return Promise.resolve(input.cursor
        ? { items: [{ id: staleVendorId, timezone: 'UTC' }] }
        : { items: [{ id: vendorId, timezone: 'UTC' }], nextCursor: 'next-page' });
    },
    findEligible: (_transaction, id) => Promise.resolve(id === vendorId
      ? { id, timezone: 'Pacific/Kiritimati' }
      : null),
  };
  let seededAt: Date | undefined;
  let seededDates: readonly string[] = [];
  let seedTimezoneDate: string | undefined;
  const claims = [claim(1), claim(2), claim(3)];
  let claimIndex = 0;
  const store = runStore({
    seedAutomatic: (transaction, input) => {
      transactions.stage(transaction, `seed:${input.vendorId}`);
      seededAt = input.now;
      seedTimezoneDate = input.triggerLocalDate;
      seededDates = input.serviceDates;
      return Promise.resolve(7);
    },
    claimNext: (transaction) => {
      const next = claims[claimIndex++] ?? null;
      transactions.stage(transaction, next ? `claim:${next.id}` : 'claim:none');
      if (!next) controller.abort();
      return Promise.resolve(next);
    },
  });
  const firstWave = deferred();
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  const processor: ScheduleRunProcessor = {
    process: async (value) => {
      assert.ok(transactions.committed.includes(`claim:${value.id}`));
      active += 1;
      started += 1;
      maximumActive = Math.max(maximumActive, active);
      if (started === options.concurrency) firstWave.resolve();
      if (started <= options.concurrency) await firstWave.promise;
      active -= 1;
      return completed(value);
    },
  };

  await new DefaultScheduleWorker(options, vendors, transactions, store, processor).run(controller.signal);

  assert.deepEqual(listCalls, [{ limit: 100 }, { cursor: 'next-page', limit: 100 }]);
  assert.ok(seededAt);
  const localToday = DateTime.fromJSDate(seededAt, { zone: 'Pacific/Kiritimati' }).toISODate()!;
  assert.equal(seedTimezoneDate, localToday);
  assert.deepEqual(seededDates, Array.from(
    { length: 7 },
    (_, days) => DateTime.fromISO(localToday).plus({ days }).toISODate()!,
  ));
  assert.deepEqual(transactions.committed.filter((event) => event.startsWith('seed:')), [`seed:${vendorId}`]);
  assert.equal(started, claims.length);
  assert.equal(maximumActive, options.concurrency);
});

void test('renews the exact claim fence in separate tenant transactions and stops on ownership loss', async () => {
  const controller = new AbortController();
  const transactions = new RecordingTransactions();
  const processing = deferred();
  const ownershipLost = deferred();
  const currentClaim = claim(1);
  let claimCalls = 0;
  const renewInputs: unknown[] = [];
  const renewContexts: TransactionContext[] = [];
  const claimContexts: TransactionContext[] = [];
  const store = runStore({
    claimNext: (transaction) => {
      claimContexts.push(transaction);
      claimCalls += 1;
      return Promise.resolve(claimCalls === 1 ? currentClaim : null);
    },
    renew: (transaction, input) => {
      renewContexts.push(transaction);
      renewInputs.push(input);
      if (renewInputs.length === 2) {
        ownershipLost.resolve();
        controller.abort();
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    },
  });
  const processor: ScheduleRunProcessor = {
    process: async (value) => {
      await processing.promise;
      return completed(value);
    },
  };
  const worker = new DefaultScheduleWorker(
    { ...options, concurrency: 1, heartbeatIntervalMs: 5 },
    { listEligible: () => Promise.resolve({ items: [{ id: vendorId, timezone: 'UTC' }] }), findEligible: (_tx, id) => Promise.resolve({ id, timezone: 'UTC' }) },
    transactions,
    store,
    processor,
  );
  const running = worker.run(controller.signal);

  await ownershipLost.promise;
  await delay(15);
  assert.deepEqual(renewInputs, [
    { fence: { id: currentClaim.id, leaseToken: currentClaim.leaseToken, attempt: currentClaim.attempt }, now: renewInputs[0] && (renewInputs[0] as { now: Date }).now },
    { fence: { id: currentClaim.id, leaseToken: currentClaim.leaseToken, attempt: currentClaim.attempt }, now: renewInputs[1] && (renewInputs[1] as { now: Date }).now },
  ]);
  assert.equal(renewContexts.length, 2);
  assert.ok(renewContexts.every((context) => !claimContexts.includes(context)));
  processing.resolve();
  await running;
});

void test('abort stops new claims and returns after the shutdown timeout when active work does not drain', async () => {
  const controller = new AbortController();
  const transactions = new RecordingTransactions();
  const processing = deferred();
  const started = deferred();
  let claimCalls = 0;
  let renewCalls = 0;
  const store = runStore({
    claimNext: () => {
      claimCalls += 1;
      return Promise.resolve(claimCalls === 1 ? claim(1) : null);
    },
    renew: () => {
      renewCalls += 1;
      return Promise.resolve(true);
    },
  });
  const processor: ScheduleRunProcessor = {
    process: async (value) => {
      started.resolve();
      await processing.promise;
      return completed(value);
    },
  };
  const worker = new DefaultScheduleWorker(
    { ...options, concurrency: 1, heartbeatIntervalMs: 5, shutdownTimeoutMs: 25 },
    { listEligible: () => Promise.resolve({ items: [{ id: vendorId, timezone: 'UTC' }] }), findEligible: (_tx, id) => Promise.resolve({ id, timezone: 'UTC' }) },
    transactions,
    store,
    processor,
  );
  const running = worker.run(controller.signal);
  await started.promise;
  controller.abort();

  assert.equal(await Promise.race([running.then(() => 'returned'), delay(200).then(() => 'timed-out')]), 'returned');
  assert.equal(claimCalls, 1);
  const renewalsAtReturn = renewCalls;
  await delay(15);
  assert.equal(renewCalls, renewalsAtReturn);
  processing.resolve();
});
