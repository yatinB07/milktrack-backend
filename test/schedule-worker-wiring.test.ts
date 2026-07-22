import assert from 'node:assert/strict';
import test from 'node:test';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module.js';
import { SchedulingLeaveService } from '../src/leave/application/scheduling-leave.service.js';
import { ScheduleWorkerModule } from '../src/schedule-worker.module.js';
import { DefaultScheduleWorker } from '../src/scheduling/application/default-schedule-worker.js';
import {
  SCHEDULE_WORKER_OPTIONS,
  ScheduleWorker,
  type ScheduleWorkerOptions,
} from '../src/scheduling/application/schedule-worker.js';
import { SchedulingVendorService } from '../src/vendors/application/scheduling-vendor.service.js';
import { PrismaSchedulingVendorService } from '../src/vendors/infrastructure/prisma-scheduling-vendor.service.js';

const applicationEnvironment = {
  APP_ENV: 'test',
  OTP_PROVIDER: 'local',
  SESSION_TTL_SECONDS: '2592000',
  DATABASE_URL: 'postgresql://milktrack_app:milktrack_app_local@postgres:5432/milktrack',
  AUTH_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
};

async function withEnvironment<T>(
  values: Readonly<Record<string, string | undefined>>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

void test('application context resolves the worker graph with parsed options and no HTTP server', async () => {
  await withEnvironment({
    DATABASE_URL: applicationEnvironment.DATABASE_URL,
    APP_ENV: undefined,
    OTP_PROVIDER: undefined,
    SESSION_TTL_SECONDS: undefined,
    AUTH_HMAC_KEY: undefined,
    MFA_ENCRYPTION_KEY: undefined,
    POLL_INTERVAL_MS: '750',
    CONCURRENCY: '7',
    HEARTBEAT_INTERVAL_MS: '20000',
    SHUTDOWN_TIMEOUT_MS: '45000',
  }, async () => {
    const app = await NestFactory.createApplicationContext(ScheduleWorkerModule, {
      abortOnError: false,
      logger: false,
    });
    try {
      const worker = app.get(ScheduleWorker);
      assert(worker instanceof DefaultScheduleWorker);
      assert.equal(worker, app.get(DefaultScheduleWorker));
      assert.deepEqual(app.get<ScheduleWorkerOptions>(SCHEDULE_WORKER_OPTIONS), {
        pollIntervalMs: 750,
        concurrency: 7,
        heartbeatIntervalMs: 20_000,
        shutdownTimeoutMs: 45_000,
      });
      assert(app.get(SchedulingVendorService) instanceof PrismaSchedulingVendorService);
      assert(app.get(SchedulingLeaveService));
      assert.equal('listen' in app, false);
    } finally {
      await app.close();
    }
  });
});

void test('application context rejects invalid worker provider configuration', async () => {
  await withEnvironment({ DATABASE_URL: applicationEnvironment.DATABASE_URL, CONCURRENCY: '0' }, () => assert.rejects(
    NestFactory.createApplicationContext(ScheduleWorkerModule, { abortOnError: false, logger: false }),
    /CONCURRENCY must be an integer between 1 and 32/,
  ));
});

void test('HTTP application context neither parses worker options nor instantiates the worker', async () => {
  await withEnvironment({ ...applicationEnvironment, CONCURRENCY: '0' }, async () => {
    const app = await NestFactory.createApplicationContext(AppModule, {
      abortOnError: false,
      logger: false,
    });
    try {
      assert.throws(() => app.get(ScheduleWorker));
      assert.throws(() => app.get(SCHEDULE_WORKER_OPTIONS));
    } finally {
      await app.close();
    }
  });
});
