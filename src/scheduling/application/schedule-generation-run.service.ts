import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { VendorService } from '../../vendors/application/vendor.service.js';
import { validateScheduleDate } from '../domain/schedule-date.js';
import type { ScheduleGenerationRun } from '../domain/schedule-generation-run.js';
import { ScheduleGenerationRunStore, type ScheduleGenerationRunPage, type ScheduleGenerationRunQuery } from './schedule-generation-run.store.js';
import { ScheduleRunProcessor } from './schedule-run-processor.js';

export type GenerateManualScheduleRunCommand = Readonly<{ serviceDate: string }>;

export abstract class ScheduleGenerationRunService {
  abstract generateManual(
    actor: Actor,
    vendorId: string,
    command: GenerateManualScheduleRunCommand,
  ): Promise<ScheduleGenerationRun>;

  abstract list(
    actor: Actor,
    vendorId: string,
    query: ScheduleGenerationRunQuery,
  ): Promise<ScheduleGenerationRunPage>;
}

@Injectable()
export class DefaultScheduleGenerationRunService extends ScheduleGenerationRunService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(VendorService) private readonly vendors: VendorService,
    @Inject(ScheduleGenerationRunStore) private readonly runs: ScheduleGenerationRunStore,
    @Inject(ScheduleRunProcessor) private readonly processor: ScheduleRunProcessor,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
  ) { super(); }

  async generateManual(
    actor: Actor,
    vendorId: string,
    command: GenerateManualScheduleRunCommand,
  ): Promise<ScheduleGenerationRun> {
    const context = requestContextStore.require();
    const claim = await this.authorization.execute(
      { actor, vendorId, permission: 'schedule:manage', operation: 'schedule.manual-generate' },
      async (tx) => {
        validateScheduleDate(command.serviceDate);
        const { timezone } = await this.vendors.getSubscriptionTimezone(tx, vendorId);
        const today = DateTime.now().setZone(timezone).toISODate();
        const lastDate = today && DateTime.fromISO(today).plus({ days: 6 }).toISODate();
        if (!today || !lastDate || command.serviceDate < today || command.serviceDate > lastDate) {
          throw new ApplicationError('INVALID_SCHEDULE_DATE', 'Schedule date is outside the rolling horizon', 400);
        }

        const now = new Date();
        const claim = await this.runs.createAndClaimManual(tx, {
          id: randomUUID(), vendorId, triggerLocalDate: today, serviceDate: command.serviceDate,
          requestedByUserId: actor.userId, leaseToken: randomUUID(), now,
        });
        await this.audits.append(tx, {
          id: randomUUID(), vendorId, actorUserId: actor.userId,
          action: 'schedule_generation.manual_requested', entityType: 'schedule_generation_run',
          entityId: claim.id,
          newValue: { trigger: claim.trigger, serviceDate: claim.serviceDate, attempt: claim.attempt },
          correlationId: context.correlationId, ipHash: context.ipHash, deviceId: context.deviceId,
        });
        return claim;
      },
    );

    try {
      const result = await this.processor.process(claim, context.correlationId);
      if (result.status === 'succeeded') return result;
    } catch {
      // The processor persists a fenced retry or terminal failure before returning control.
    }
    throw new ApplicationError(
      'SCHEDULE_GENERATION_FAILED',
      'Schedule generation could not be completed',
      503,
      true,
      undefined,
      undefined,
      claim.id,
    );
  }

  list(actor: Actor, vendorId: string, query: ScheduleGenerationRunQuery): Promise<ScheduleGenerationRunPage> {
    return this.authorization.execute(
      { actor, vendorId, permission: 'schedule:read', operation: 'schedule.run-list' },
      async (tx) => {
        if (query.serviceDate !== undefined) validateScheduleDate(query.serviceDate);
        return this.runs.list(tx, vendorId, query);
      },
    );
  }
}
