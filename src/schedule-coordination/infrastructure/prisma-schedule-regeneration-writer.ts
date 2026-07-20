import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ScheduleRegenerationWriter } from '../application/schedule-regeneration-writer.js';

@Injectable()
export class PrismaScheduleRegenerationWriter extends ScheduleRegenerationWriter {
  async write(
    transaction: TransactionContext,
    vendorId: string,
    triggerLocalDate: string,
    serviceDates: readonly string[],
    requestedByUserId: string,
  ): Promise<void> {
    const prisma = unwrapPrismaTransaction(transaction);
    for (const serviceDate of [...new Set(serviceDates)].sort()) {
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO schedule_generation_runs (
          id,vendor_id,trigger,trigger_local_date,service_date,status,requested_by_user_id,updated_at
        ) VALUES (
          ${randomUUID()}::uuid,${vendorId}::uuid,'configuration_change',${triggerLocalDate}::date,
          ${serviceDate}::date,'queued',${requestedByUserId}::uuid,CURRENT_TIMESTAMP
        ) ON CONFLICT (vendor_id,service_date)
          WHERE trigger='configuration_change' AND status IN ('queued','running','retry_wait') DO UPDATE SET
            available_at=GREATEST(
              schedule_generation_runs.available_at,
              schedule_generation_runs.claimed_at + interval '1 microsecond',
              clock_timestamp()
            ),
            updated_at=clock_timestamp()
          WHERE schedule_generation_runs.status='running'
      `);
    }
  }
}
