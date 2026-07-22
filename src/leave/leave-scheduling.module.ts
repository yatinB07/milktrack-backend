import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { LeaveStore } from './application/leave.store.js';
import { DefaultSchedulingLeaveService, SchedulingLeaveService } from './application/scheduling-leave.service.js';
import { PrismaLeaveStore } from './infrastructure/prisma-leave.store.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    PrismaLeaveStore,
    { provide: LeaveStore, useExisting: PrismaLeaveStore },
    DefaultSchedulingLeaveService,
    { provide: SchedulingLeaveService, useExisting: DefaultSchedulingLeaveService },
  ],
  exports: [LeaveStore, SchedulingLeaveService],
})
export class LeaveSchedulingModule {}
