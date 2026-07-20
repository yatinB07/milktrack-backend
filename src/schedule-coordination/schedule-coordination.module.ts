import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { ScheduleDateLock } from './application/schedule-date-lock.js';
import { ScheduleRegenerationWriter } from './application/schedule-regeneration-writer.js';
import { PrismaScheduleDateLock } from './infrastructure/prisma-schedule-date-lock.js';
import { PrismaScheduleRegenerationWriter } from './infrastructure/prisma-schedule-regeneration-writer.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    PrismaScheduleDateLock,
    { provide: ScheduleDateLock, useExisting: PrismaScheduleDateLock },
    PrismaScheduleRegenerationWriter,
    { provide: ScheduleRegenerationWriter, useExisting: PrismaScheduleRegenerationWriter },
  ],
  exports: [ScheduleDateLock, ScheduleRegenerationWriter],
})
export class ScheduleCoordinationModule {}
