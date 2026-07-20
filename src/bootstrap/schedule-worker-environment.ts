import type { ScheduleWorkerOptions } from '../scheduling/application/schedule-worker.js';
import { SCHEDULE_GENERATION_HEARTBEAT_SECONDS } from '../scheduling/domain/schedule-generation-run.js';

export interface ScheduleWorkerEnvironment {
  readonly POLL_INTERVAL_MS?: string;
  readonly CONCURRENCY?: string;
  readonly SHUTDOWN_TIMEOUT_MS?: string;
}

function boundedInteger(
  name: keyof ScheduleWorkerEnvironment,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value === undefined ? String(defaultValue) : value;
  if (!/^\d+$/.test(candidate)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  const parsed = Number(candidate);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function scheduleWorkerOptionsFromEnvironment(
  environment: ScheduleWorkerEnvironment,
): ScheduleWorkerOptions {
  return {
    pollIntervalMs: boundedInteger(
      'POLL_INTERVAL_MS',
      environment.POLL_INTERVAL_MS,
      5_000,
      250,
      60_000,
    ),
    concurrency: boundedInteger(
      'CONCURRENCY',
      environment.CONCURRENCY,
      4,
      1,
      32,
    ),
    heartbeatIntervalMs: SCHEDULE_GENERATION_HEARTBEAT_SECONDS * 1_000,
    shutdownTimeoutMs: boundedInteger(
      'SHUTDOWN_TIMEOUT_MS',
      environment.SHUTDOWN_TIMEOUT_MS,
      60_000,
      1_000,
      60_000,
    ),
  };
}
