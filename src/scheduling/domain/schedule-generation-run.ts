export const SCHEDULE_GENERATION_MAX_ATTEMPTS = 5;
export const SCHEDULE_GENERATION_LEASE_SECONDS = 60;
export const SCHEDULE_GENERATION_RETRY_BACKOFF_SECONDS = [5, 10, 20, 40] as const;
export const SCHEDULE_GENERATION_RETRY_BACKOFF_CAP_SECONDS = 300;
export const SCHEDULE_GENERATION_FAILURE_CODE_MAX_LENGTH = 128;
export const SCHEDULE_GENERATION_FAILURE_MESSAGE_MAX_LENGTH = 500;

export type ScheduleGenerationTrigger = 'automatic' | 'manual' | 'configuration_change';
export type ScheduleGenerationRunStatus = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed';

export type ScheduleGenerationRunCounts = Readonly<{
  created: number;
  existing: number;
  updated: number;
  cancelled: number;
  missingPrice: number;
}>;

export type ScheduleGenerationRun = Readonly<{
  id: string;
  vendorId: string;
  trigger: ScheduleGenerationTrigger;
  triggerLocalDate: string;
  serviceDate: string;
  status: ScheduleGenerationRunStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: Date;
  leaseToken?: string;
  claimedAt?: Date;
  leaseExpiresAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  failureCode?: string;
  failureMessage?: string;
  requestedByUserId?: string;
  counts?: ScheduleGenerationRunCounts;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ScheduleGenerationRunFence = Readonly<{
  id: string;
  leaseToken: string;
  attempt: number;
}>;

export type ScheduleGenerationRunClaim = Readonly<{
  id: string;
  vendorId: string;
  trigger: ScheduleGenerationTrigger;
  triggerLocalDate: string;
  serviceDate: string;
  attempt: number;
  maxAttempts: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  requestedByUserId?: string;
}>;
