import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { scheduleWorkerOptionsFromEnvironment } from '../src/bootstrap/schedule-worker-environment.js';
import { ScheduleWorker } from '../src/scheduling/application/schedule-worker.js';
import { runScheduleWorkerContext } from '../src/worker.js';

void test('worker environment uses bounded defaults and the fixed heartbeat', () => {
  assert.deepEqual(scheduleWorkerOptionsFromEnvironment({}), {
    pollIntervalMs: 5_000,
    concurrency: 4,
    heartbeatIntervalMs: 20_000,
    shutdownTimeoutMs: 60_000,
  });

  assert.deepEqual(
    scheduleWorkerOptionsFromEnvironment({
      POLL_INTERVAL_MS: '250',
      CONCURRENCY: '32',
      SHUTDOWN_TIMEOUT_MS: '300000',
    }),
    {
      pollIntervalMs: 250,
      concurrency: 32,
      heartbeatIntervalMs: 20_000,
      shutdownTimeoutMs: 300_000,
    },
  );
});

void test('worker environment rejects malformed and out-of-range integers', () => {
  const invalidValues: ReadonlyArray<readonly [string, string]> = [
    ['POLL_INTERVAL_MS', '249'],
    ['POLL_INTERVAL_MS', '60001'],
    ['POLL_INTERVAL_MS', '250.5'],
    ['CONCURRENCY', '0'],
    ['CONCURRENCY', '33'],
    ['CONCURRENCY', 'four'],
    ['SHUTDOWN_TIMEOUT_MS', '999'],
    ['SHUTDOWN_TIMEOUT_MS', '300001'],
    ['SHUTDOWN_TIMEOUT_MS', ''],
  ];

  for (const [name, value] of invalidValues) {
    assert.throws(
      () => scheduleWorkerOptionsFromEnvironment({ [name]: value }),
      new RegExp(`${name} must be an integer between `),
    );
  }
});

void test('worker context aborts on a shutdown signal and always closes', async () => {
  const signals = new EventEmitter();
  let receivedSignal: AbortSignal | undefined;
  let closeCount = 0;
  const worker: ScheduleWorker = {
    run(signal) {
      receivedSignal = signal;
      return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
  };
  const app = {
    get(token: typeof ScheduleWorker) {
      assert.equal(token, ScheduleWorker);
      return worker;
    },
    close() {
      closeCount += 1;
      return Promise.resolve();
    },
  };

  const running = runScheduleWorkerContext(app, signals);
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  await running;

  assert.equal(receivedSignal?.aborted, true);
  assert.equal(closeCount, 1);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

void test('worker context closes when worker execution fails', async () => {
  const failure = new Error('worker failed');
  let closeCount = 0;
  const app = {
    get() {
      return { run: () => Promise.reject(failure) } as ScheduleWorker;
    },
    close() {
      closeCount += 1;
      return Promise.resolve();
    },
  };

  await assert.rejects(runScheduleWorkerContext(app, new EventEmitter()), failure);
  assert.equal(closeCount, 1);
});

void test('package exposes development and production worker commands', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.scripts['start:worker'], 'node dist/worker.js');
  assert.equal(
    packageJson.scripts['start:worker:dev'],
    'node --import tsx src/worker.ts',
  );

  const entrypoint = await readFile('src/worker.ts', 'utf8');
  assert.match(entrypoint, /NestFactory\.createApplicationContext\(AppModule\)/);
  assert.doesNotMatch(entrypoint, /NestFactory\.create\(|\.listen\(|Swagger/);
});
