import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  type ClaimNextScheduleRun,
  type CreateAndClaimManualScheduleRun,
  type FailScheduleRun,
  type RenewScheduleRun,
  ScheduleGenerationRunStore,
  type ScheduleGenerationRunQuery,
  type SucceedScheduleRun,
} from '../application/schedule-generation-run.store.js';
import {
  SCHEDULE_GENERATION_LEASE_SECONDS,
  SCHEDULE_GENERATION_MAX_ATTEMPTS,
  type ScheduleGenerationRun,
  type ScheduleGenerationRunClaim,
  type ScheduleGenerationRunCounts,
  type ScheduleGenerationRunStatus,
  type ScheduleGenerationTrigger,
} from '../domain/schedule-generation-run.js';
import {
  normalizeScheduleRunFailure,
  planScheduleRunFailure,
} from '../domain/schedule-run-state.js';

type RunRow = Readonly<{
  id: string;
  vendorId: string;
  trigger: ScheduleGenerationTrigger;
  triggerLocalDate: Date;
  serviceDate: Date;
  status: ScheduleGenerationRunStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: Date;
  leaseToken: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  requestedByUserId: string | null;
  createdCount: number | null;
  existingCount: number | null;
  updatedCount: number | null;
  cancelledCount: number | null;
  missingPriceCount: number | null;
  createdAt: Date;
  updatedAt: Date;
}>;

const runColumns = Prisma.sql`
  id,vendor_id AS "vendorId",trigger,trigger_local_date AS "triggerLocalDate",
  service_date AS "serviceDate",status,attempt_count AS attempt,max_attempts AS "maxAttempts",
  available_at AS "availableAt",lease_token AS "leaseToken",claimed_at AS "claimedAt",
  lease_expires_at AS "leaseExpiresAt",started_at AS "startedAt",finished_at AS "finishedAt",
  failure_code AS "failureCode",failure_message AS "failureMessage",
  requested_by_user_id AS "requestedByUserId",created_count AS "createdCount",
  existing_count AS "existingCount",updated_count AS "updatedCount",
  cancelled_count AS "cancelledCount",missing_price_count AS "missingPriceCount",
  created_at AS "createdAt",updated_at AS "updatedAt"`;

@Injectable()
export class PrismaScheduleGenerationRunStore extends ScheduleGenerationRunStore {
  private readonly cursors = new CursorCodec();

  async createAndClaimManual(
    context: TransactionContext,
    input: CreateAndClaimManualScheduleRun,
  ): Promise<ScheduleGenerationRunClaim> {
    const tx = unwrapPrismaTransaction(context);
    const leaseExpiresAt = this.leaseExpiry(input.now);
    const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`
      INSERT INTO schedule_generation_runs (
        id,vendor_id,trigger,trigger_local_date,service_date,status,attempt_count,max_attempts,
        available_at,lease_token,claimed_at,lease_expires_at,started_at,requested_by_user_id,updated_at
      ) VALUES (
        ${input.id}::uuid,${input.vendorId}::uuid,'manual',${input.triggerLocalDate}::date,
        ${input.serviceDate}::date,'running',1,${SCHEDULE_GENERATION_MAX_ATTEMPTS},${input.now},
        ${input.leaseToken}::uuid,${input.now},${leaseExpiresAt},${input.now},
        ${input.requestedByUserId}::uuid,${input.now}
      ) RETURNING ${runColumns}`);
    return this.claim(rows[0]);
  }

  async claimNext(
    context: TransactionContext,
    input: ClaimNextScheduleRun,
  ): Promise<ScheduleGenerationRunClaim | null> {
    const tx = unwrapPrismaTransaction(context);
    const leaseExpiresAt = this.leaseExpiry(input.now);
    await tx.$executeRaw(Prisma.sql`
      WITH exhausted AS (
        SELECT id AS exhausted_id FROM schedule_generation_runs
        WHERE vendor_id=${input.vendorId}::uuid AND status='running'
          AND attempt_count=max_attempts AND lease_expires_at<=${input.now}
        ORDER BY lease_expires_at,created_at,id
        FOR UPDATE SKIP LOCKED
      )
      UPDATE schedule_generation_runs r SET
        status='failed',lease_token=NULL,claimed_at=NULL,lease_expires_at=NULL,
        finished_at=${input.now},failure_code='LEASE_EXPIRED',
        failure_message='Schedule generation lease expired after final attempt',updated_at=${input.now}
      FROM exhausted WHERE r.id=exhausted.exhausted_id`);
    const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`
      WITH candidate AS (
        SELECT id AS candidate_id FROM schedule_generation_runs
        WHERE vendor_id=${input.vendorId}::uuid AND attempt_count<max_attempts AND (
          (status IN ('queued','retry_wait') AND available_at<=${input.now})
          OR (status='running' AND lease_expires_at<=${input.now})
        )
        ORDER BY
          CASE WHEN status='running' THEN lease_expires_at ELSE available_at END,
          created_at,id
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE schedule_generation_runs r SET
        status='running',attempt_count=r.attempt_count+1,lease_token=${input.leaseToken}::uuid,
        claimed_at=${input.now},lease_expires_at=${leaseExpiresAt},
        started_at=COALESCE(r.started_at,${input.now}),finished_at=NULL,
        failure_code=NULL,failure_message=NULL,updated_at=${input.now}
      FROM candidate WHERE r.id=candidate.candidate_id
      RETURNING ${runColumns}`);
    return rows[0] ? this.claim(rows[0]) : null;
  }

  async renew(context: TransactionContext, input: RenewScheduleRun): Promise<boolean> {
    const tx = unwrapPrismaTransaction(context);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE schedule_generation_runs SET lease_expires_at=${this.leaseExpiry(input.now)},updated_at=${input.now}
      WHERE id=${input.fence.id}::uuid AND lease_token=${input.fence.leaseToken}::uuid
        AND attempt_count=${input.fence.attempt} AND status='running'
        AND lease_expires_at>${input.now}`);
    return updated === 1;
  }

  async succeed(
    context: TransactionContext,
    input: SucceedScheduleRun,
  ): Promise<ScheduleGenerationRun | null> {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`
      UPDATE schedule_generation_runs SET
        status='succeeded',lease_token=NULL,claimed_at=NULL,lease_expires_at=NULL,
        finished_at=${input.finishedAt},created_count=${input.counts.created},
        existing_count=${input.counts.existing},updated_count=${input.counts.updated},
        cancelled_count=${input.counts.cancelled},missing_price_count=${input.counts.missingPrice},
        updated_at=${input.finishedAt}
      WHERE id=${input.fence.id}::uuid AND lease_token=${input.fence.leaseToken}::uuid
        AND attempt_count=${input.fence.attempt} AND status='running'
      RETURNING ${runColumns}`);
    return rows[0] ? this.run(rows[0]) : null;
  }

  async fail(
    context: TransactionContext,
    input: FailScheduleRun,
  ): Promise<ScheduleGenerationRun | null> {
    const tx = unwrapPrismaTransaction(context);
    const current = await tx.$queryRaw<Array<{ maxAttempts: number }>>(Prisma.sql`
      SELECT max_attempts AS "maxAttempts" FROM schedule_generation_runs
      WHERE id=${input.fence.id}::uuid AND lease_token=${input.fence.leaseToken}::uuid
        AND attempt_count=${input.fence.attempt} AND status='running'
      FOR UPDATE`);
    if (!current[0]) return null;
    const failure = normalizeScheduleRunFailure(input.code, input.message);
    const transition = planScheduleRunFailure(
      input.fence.attempt,
      current[0].maxAttempts,
      input.retryable,
      input.failedAt,
    );
    const rows = transition.status === 'retry_wait'
      ? await tx.$queryRaw<RunRow[]>(Prisma.sql`
          UPDATE schedule_generation_runs SET
            status='retry_wait',available_at=${transition.availableAt},lease_token=NULL,
            claimed_at=NULL,lease_expires_at=NULL,failure_code=${failure.code},
            failure_message=${failure.message},updated_at=${input.failedAt}
          WHERE id=${input.fence.id}::uuid AND lease_token=${input.fence.leaseToken}::uuid
            AND attempt_count=${input.fence.attempt} AND status='running'
          RETURNING ${runColumns}`)
      : await tx.$queryRaw<RunRow[]>(Prisma.sql`
          UPDATE schedule_generation_runs SET
            status='failed',lease_token=NULL,claimed_at=NULL,lease_expires_at=NULL,
            finished_at=${transition.finishedAt},failure_code=${failure.code},
            failure_message=${failure.message},updated_at=${input.failedAt}
          WHERE id=${input.fence.id}::uuid AND lease_token=${input.fence.leaseToken}::uuid
            AND attempt_count=${input.fence.attempt} AND status='running'
          RETURNING ${runColumns}`);
    return rows[0] ? this.run(rows[0]) : null;
  }

  async list(
    context: TransactionContext,
    vendorId: string,
    query: ScheduleGenerationRunQuery,
  ) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const filters = [Prisma.sql`vendor_id=${vendorId}::uuid`];
    if (query.trigger) filters.push(Prisma.sql`trigger=${query.trigger}`);
    if (query.status) filters.push(Prisma.sql`status=${query.status}`);
    if (query.serviceDate) filters.push(Prisma.sql`service_date=${query.serviceDate}::date`);
    if (cursor) filters.push(Prisma.sql`
      (created_at<${cursor.createdAt} OR (created_at=${cursor.createdAt} AND id<${cursor.id}::uuid))`);
    const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`
      SELECT ${runColumns} FROM schedule_generation_runs
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`);
    const items = rows.slice(0, limit).map((row) => this.run(row));
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last
        ? { nextCursor: this.cursors.encode({ createdAt: last.createdAt, id: last.id }) }
        : {}),
    };
  }

  private leaseExpiry(now: Date): Date {
    return new Date(now.getTime() + SCHEDULE_GENERATION_LEASE_SECONDS * 1_000);
  }

  private claim(row: RunRow): ScheduleGenerationRunClaim {
    if (!row.leaseToken || !row.leaseExpiresAt) throw new Error('Claimed run is missing its lease');
    return {
      id: row.id,
      vendorId: row.vendorId,
      trigger: row.trigger,
      triggerLocalDate: this.date(row.triggerLocalDate),
      serviceDate: this.date(row.serviceDate),
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      leaseToken: row.leaseToken,
      leaseExpiresAt: row.leaseExpiresAt,
      ...(row.requestedByUserId ? { requestedByUserId: row.requestedByUserId } : {}),
    };
  }

  private run(row: RunRow): ScheduleGenerationRun {
    const counts = this.counts(row);
    return {
      id: row.id,
      vendorId: row.vendorId,
      trigger: row.trigger,
      triggerLocalDate: this.date(row.triggerLocalDate),
      serviceDate: this.date(row.serviceDate),
      status: row.status,
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      availableAt: row.availableAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
      ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}),
      ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
      ...(row.startedAt ? { startedAt: row.startedAt } : {}),
      ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
      ...(row.failureCode ? { failureCode: row.failureCode } : {}),
      ...(row.failureMessage ? { failureMessage: row.failureMessage } : {}),
      ...(row.requestedByUserId ? { requestedByUserId: row.requestedByUserId } : {}),
      ...(counts ? { counts } : {}),
    };
  }

  private counts(row: RunRow): ScheduleGenerationRunCounts | undefined {
    if (row.createdCount === null || row.existingCount === null || row.updatedCount === null
      || row.cancelledCount === null || row.missingPriceCount === null) return undefined;
    return {
      created: row.createdCount,
      existing: row.existingCount,
      updated: row.updatedCount,
      cancelled: row.cancelledCount,
      missingPrice: row.missingPriceCount,
    };
  }

  private date(value: Date): string {
    return value.toISOString().slice(0, 10);
  }
}
