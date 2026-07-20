import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TenantTransactionRunner,
  type TransactionContext,
} from '../src/common/application/transaction-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { ScheduleGenerationRunStore } from '../src/scheduling/application/schedule-generation-run.store.js';
import { ScheduleGenerator } from '../src/scheduling/application/schedule-generator.js';
import { DefaultScheduleRunProcessor } from '../src/scheduling/application/default-schedule-run-processor.js';
import type {
  ScheduleGenerationRun,
  ScheduleGenerationRunClaim,
} from '../src/scheduling/domain/schedule-generation-run.js';

const claim: ScheduleGenerationRunClaim = {
  id: '10000000-0000-4000-8000-000000000001',
  vendorId: '20000000-0000-4000-8000-000000000001',
  trigger: 'automatic',
  triggerLocalDate: '2030-01-01',
  serviceDate: '2030-01-02',
  attempt: 1,
  maxAttempts: 5,
  leaseToken: '30000000-0000-4000-8000-000000000001',
  leaseExpiresAt: new Date('2030-01-01T00:01:00.000Z'),
};
const counts = { created: 1, existing: 2, updated: 3, cancelled: 4, missingPrice: 5 };

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

function completed(status: 'succeeded' | 'failed' | 'retry_wait'): ScheduleGenerationRun {
  return {
    ...claim,
    status,
    availableAt: new Date('2030-01-01T00:00:00.000Z'),
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    updatedAt: new Date('2030-01-01T00:00:01.000Z'),
    ...(status === 'succeeded' ? { counts } : {}),
  };
}

function runStore(overrides: Partial<ScheduleGenerationRunStore>): ScheduleGenerationRunStore {
  return {
    createAndClaimManual: () => Promise.reject(new Error('unused')),
    claimNext: () => Promise.reject(new Error('unused')),
    renew: () => Promise.reject(new Error('unused')),
    succeed: () => Promise.reject(new Error('unused')),
    fail: () => Promise.reject(new Error('unused')),
    list: () => Promise.reject(new Error('unused')),
    ...overrides,
  };
}

void test('generator effects and fenced success commit in one tenant transaction', async () => {
  const transactions = new RecordingTransactions();
  const generator: ScheduleGenerator = {
    generate: (transaction) => {
      transactions.stage(transaction, 'generated');
      return Promise.resolve(counts);
    },
  };
  const store = runStore({
    succeed: (transaction, input) => {
      transactions.stage(transaction, `succeeded:${input.fence.leaseToken}`);
      return Promise.resolve(completed('succeeded'));
    },
  });

  const result = await new DefaultScheduleRunProcessor(transactions, generator, store).process(claim);

  assert.equal(result.status, 'succeeded');
  assert.equal(transactions.contexts.length, 1);
  assert.deepEqual(transactions.committed, ['generated', `succeeded:${claim.leaseToken}`]);
});

void test('generator failure rolls back before durable failure is recorded separately', async () => {
  const transactions = new RecordingTransactions();
  const generator: ScheduleGenerator = {
    generate: (transaction) => {
      transactions.stage(transaction, 'generated');
      return Promise.reject(new ApplicationError(
        'TRANSIENT_GENERATION',
        'Temporary generation failure',
        503,
        true,
      ));
    },
  };
  const store = runStore({
    fail: (transaction, input) => {
      transactions.stage(transaction, `failure:${input.code}:${input.retryable}`);
      return Promise.resolve(completed('retry_wait'));
    },
  });

  await assert.rejects(
    new DefaultScheduleRunProcessor(transactions, generator, store).process(claim, 'correlation'),
    (cause: unknown) => cause instanceof ApplicationError
      && cause.code === 'SCHEDULE_GENERATION_FAILED'
      && cause.status === 503,
  );
  assert.equal(transactions.contexts.length, 2);
  assert.notEqual(transactions.contexts[0], transactions.contexts[1]);
  assert.deepEqual(transactions.committed, ['failure:TRANSIENT_GENERATION:true']);
});
