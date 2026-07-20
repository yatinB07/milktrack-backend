import {
  SCHEDULE_GENERATION_FAILURE_CODE_MAX_LENGTH,
  SCHEDULE_GENERATION_FAILURE_MESSAGE_MAX_LENGTH,
  SCHEDULE_GENERATION_RETRY_BACKOFF_CAP_SECONDS,
  SCHEDULE_GENERATION_RETRY_BACKOFF_SECONDS,
} from './schedule-generation-run.js';

export type ScheduleRunFailureTransition =
  | Readonly<{ status: 'retry_wait'; availableAt: Date }>
  | Readonly<{ status: 'failed'; finishedAt: Date }>;

export function planScheduleRunFailure(
  attempt: number,
  maxAttempts: number,
  retryable: boolean,
  failedAt: Date,
): ScheduleRunFailureTransition {
  if (!retryable || attempt >= maxAttempts) return { status: 'failed', finishedAt: failedAt };
  const configured = SCHEDULE_GENERATION_RETRY_BACKOFF_SECONDS[
    Math.min(attempt - 1, SCHEDULE_GENERATION_RETRY_BACKOFF_SECONDS.length - 1)
  ] ?? SCHEDULE_GENERATION_RETRY_BACKOFF_CAP_SECONDS;
  const seconds = Math.min(configured, SCHEDULE_GENERATION_RETRY_BACKOFF_CAP_SECONDS);
  return { status: 'retry_wait', availableAt: new Date(failedAt.getTime() + seconds * 1_000) };
}

export function normalizeScheduleRunFailure(code: string, message: string) {
  return {
    code: code.trim().slice(0, SCHEDULE_GENERATION_FAILURE_CODE_MAX_LENGTH)
      || 'SCHEDULE_GENERATION_FAILED',
    message: message.trim().slice(0, SCHEDULE_GENERATION_FAILURE_MESSAGE_MAX_LENGTH)
      || 'Schedule generation failed',
  } as const;
}
