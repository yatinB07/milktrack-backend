import { Inject, Injectable } from '@nestjs/common';

import { TenantTransactionRunner } from '../../common/application/transaction-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import type {
  ScheduleGenerationRun,
  ScheduleGenerationRunClaim,
} from '../domain/schedule-generation-run.js';
import { normalizeScheduleRunFailure } from '../domain/schedule-run-state.js';
import { ScheduleGenerationRunStore } from './schedule-generation-run.store.js';
import { ScheduleGenerator } from './schedule-generator.js';
import { ScheduleRunProcessor } from './schedule-run-processor.js';

@Injectable()
export class DefaultScheduleRunProcessor extends ScheduleRunProcessor {
  constructor(
    @Inject(TenantTransactionRunner)
    private readonly transactions: TenantTransactionRunner,
    @Inject(ScheduleGenerator)
    private readonly generator: ScheduleGenerator,
    @Inject(ScheduleGenerationRunStore)
    private readonly runs: ScheduleGenerationRunStore,
  ) {
    super();
  }

  async process(
    claim: ScheduleGenerationRunClaim,
    correlationId?: string,
  ): Promise<ScheduleGenerationRun> {
    void correlationId;
    try {
      return await this.transactions.run(claim.vendorId, async (transaction) => {
        const counts = await this.generator.generate(
          transaction,
          claim.vendorId,
          claim.serviceDate,
        );
        const succeeded = await this.runs.succeed(transaction, {
          fence: claim,
          counts,
          finishedAt: new Date(),
        });
        if (!succeeded) throw this.stateConflict();
        return succeeded;
      });
    } catch (cause) {
      const source = cause instanceof ApplicationError
        ? { code: cause.code, message: cause.message, retryable: cause.retryable }
        : { code: 'SCHEDULE_GENERATION_FAILED', message: 'Schedule generation failed', retryable: true };
      const failure = normalizeScheduleRunFailure(source.code, source.message);
      const failed = await this.transactions.run(claim.vendorId, (transaction) => this.runs.fail(
        transaction,
        {
          fence: claim,
          ...failure,
          retryable: source.retryable,
          failedAt: new Date(),
        },
      ));
      if (!failed) throw this.stateConflict();
      throw new ApplicationError(
        'SCHEDULE_GENERATION_FAILED',
        'Schedule generation failed',
        503,
        failed.status === 'retry_wait',
      );
    }
  }

  private stateConflict(): ApplicationError {
    return new ApplicationError(
      'SCHEDULE_RUN_STATE_CONFLICT',
      'Schedule generation run is no longer owned by this worker',
      409,
    );
  }
}
