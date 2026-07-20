import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { ScheduleDateLock } from './application/schedule-date-lock.js';
import { PrismaScheduleDateLock } from './infrastructure/prisma-schedule-date-lock.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    PrismaScheduleDateLock,
    { provide: ScheduleDateLock, useExisting: PrismaScheduleDateLock },
  ],
  exports: [ScheduleDateLock],
})
export class ScheduleCoordinationModule {}
