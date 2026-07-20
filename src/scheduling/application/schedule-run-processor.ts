import type {
  ScheduleGenerationRun,
  ScheduleGenerationRunClaim,
} from '../domain/schedule-generation-run.js';

export abstract class ScheduleRunProcessor {
  abstract process(
    claim: ScheduleGenerationRunClaim,
    correlationId?: string,
  ): Promise<ScheduleGenerationRun>;
}
