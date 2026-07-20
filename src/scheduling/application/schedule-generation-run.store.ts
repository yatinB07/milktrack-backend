import type { TransactionContext } from '../../common/application/transaction-context.js';
import type {
  ScheduleGenerationRun,
  ScheduleGenerationRunClaim,
  ScheduleGenerationRunCounts,
  ScheduleGenerationRunFence,
  ScheduleGenerationRunStatus,
  ScheduleGenerationTrigger,
} from '../domain/schedule-generation-run.js';

export type CreateAndClaimManualScheduleRun = Readonly<{
  id: string;
  vendorId: string;
  triggerLocalDate: string;
  serviceDate: string;
  requestedByUserId: string;
  leaseToken: string;
  now: Date;
}>;

export type ClaimNextScheduleRun = Readonly<{
  vendorId: string;
  leaseToken: string;
  now: Date;
}>;

export type SeedAutomaticScheduleRuns = Readonly<{
  vendorId: string;
  triggerLocalDate: string;
  serviceDates: readonly string[];
  now: Date;
}>;

export type RenewScheduleRun = Readonly<{
  fence: ScheduleGenerationRunFence;
  now: Date;
}>;

export type SucceedScheduleRun = Readonly<{
  fence: ScheduleGenerationRunFence;
  counts: ScheduleGenerationRunCounts;
  finishedAt: Date;
}>;

export type FailScheduleRun = Readonly<{
  fence: ScheduleGenerationRunFence;
  code: string;
  message: string;
  retryable: boolean;
  failedAt: Date;
}>;

export type ScheduleGenerationRunQuery = Readonly<{
  trigger?: ScheduleGenerationTrigger;
  status?: ScheduleGenerationRunStatus;
  serviceDate?: string;
  cursor?: string;
  limit?: number;
}>;

export type ScheduleGenerationRunPage = Readonly<{
  items: readonly ScheduleGenerationRun[];
  nextCursor?: string;
}>;

export abstract class ScheduleGenerationRunStore {
  abstract seedAutomatic(
    transaction: TransactionContext,
    input: SeedAutomaticScheduleRuns,
  ): Promise<number>;

  abstract createAndClaimManual(
    transaction: TransactionContext,
    input: CreateAndClaimManualScheduleRun,
  ): Promise<ScheduleGenerationRunClaim>;

  abstract claimNext(
    transaction: TransactionContext,
    input: ClaimNextScheduleRun,
  ): Promise<ScheduleGenerationRunClaim | null>;

  abstract renew(transaction: TransactionContext, input: RenewScheduleRun): Promise<boolean>;

  abstract succeed(
    transaction: TransactionContext,
    input: SucceedScheduleRun,
  ): Promise<ScheduleGenerationRun | null>;

  abstract fail(
    transaction: TransactionContext,
    input: FailScheduleRun,
  ): Promise<ScheduleGenerationRun | null>;

  abstract list(
    transaction: TransactionContext,
    vendorId: string,
    query: ScheduleGenerationRunQuery,
  ): Promise<ScheduleGenerationRunPage>;
}
