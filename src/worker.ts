import 'reflect-metadata';

import { pathToFileURL } from 'node:url';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ScheduleWorkerModule } from './schedule-worker.module.js';
import { ScheduleWorker } from './scheduling/application/schedule-worker.js';

type WorkerApplicationContext = Pick<INestApplicationContext, 'close'> & {
  get(token: typeof ScheduleWorker): ScheduleWorker;
};

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

interface ShutdownSignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export async function runScheduleWorkerContext(
  app: WorkerApplicationContext,
  signals: ShutdownSignalSource = process,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  signals.once('SIGTERM', abort);
  signals.once('SIGINT', abort);

  try {
    await app.get(ScheduleWorker).run(controller.signal);
  } finally {
    signals.off('SIGTERM', abort);
    signals.off('SIGINT', abort);
    await app.close();
  }
}

export async function startScheduleWorker(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ScheduleWorkerModule);
  await runScheduleWorkerContext(app);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await startScheduleWorker();
}
