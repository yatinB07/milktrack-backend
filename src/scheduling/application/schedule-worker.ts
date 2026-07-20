export const SCHEDULE_WORKER_OPTIONS = Symbol('SCHEDULE_WORKER_OPTIONS');

export type ScheduleWorkerOptions = Readonly<{
  pollIntervalMs: number;
  concurrency: number;
  heartbeatIntervalMs: number;
  shutdownTimeoutMs: number;
}>;

export abstract class ScheduleWorker {
  abstract run(signal: AbortSignal): Promise<void>;
}
