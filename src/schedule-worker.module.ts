import { Module } from '@nestjs/common';

import { scheduleWorkerOptionsFromEnvironment } from './bootstrap/schedule-worker-environment.js';
import { DatabaseModule } from './database/database.module.js';
import { DefaultScheduleWorker } from './scheduling/application/default-schedule-worker.js';
import { SCHEDULE_WORKER_OPTIONS, ScheduleWorker } from './scheduling/application/schedule-worker.js';
import { SchedulingModule } from './scheduling/scheduling.module.js';
import { VendorsModule } from './vendors/vendors.module.js';

@Module({
  imports: [DatabaseModule, SchedulingModule, VendorsModule],
  providers: [
    {
      provide: SCHEDULE_WORKER_OPTIONS,
      useFactory: () => scheduleWorkerOptionsFromEnvironment(process.env),
    },
    DefaultScheduleWorker,
    { provide: ScheduleWorker, useExisting: DefaultScheduleWorker },
  ],
})
export class ScheduleWorkerModule {}
