import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultScheduleGenerationRunService, ScheduleGenerationRunService } from '../src/scheduling/application/schedule-generation-run.service.js';
import { ScheduleGenerationRunStore } from '../src/scheduling/application/schedule-generation-run.store.js';
import { DefaultScheduleRunProcessor } from '../src/scheduling/application/default-schedule-run-processor.js';
import { ScheduleRunProcessor } from '../src/scheduling/application/schedule-run-processor.js';
import { ScheduleGenerationRunController } from '../src/scheduling/http/schedule-generation-run.controller.js';
import { PrismaScheduleGenerationRunStore } from '../src/scheduling/infrastructure/prisma-schedule-generation-run.store.js';

void test('application resolves the complete schedule generation HTTP provider graph', async () => {
  const { createApp } = await import('../src/bootstrap/create-app.js');
  const app = await createApp({ logger: false });
  try {
    assert(app.get(ScheduleGenerationRunController) instanceof ScheduleGenerationRunController);
    assert(app.get(ScheduleGenerationRunService) instanceof DefaultScheduleGenerationRunService);
    assert(app.get(ScheduleGenerationRunStore) instanceof PrismaScheduleGenerationRunStore);
    assert(app.get(ScheduleRunProcessor) instanceof DefaultScheduleRunProcessor);
  } finally {
    await app.close();
  }
});
