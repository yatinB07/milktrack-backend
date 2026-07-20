import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import type { ScheduleGenerationRun, ScheduleGenerationRunCounts, ScheduleGenerationRunStatus, ScheduleGenerationTrigger } from '../domain/schedule-generation-run.js';

const serviceDate = /^\d{4}-\d{2}-\d{2}$/;

export class GenerateManualScheduleRunRequestDto {
  @ApiProperty({ type: String, format: 'date' }) @IsString() @Matches(serviceDate)
  serviceDate!: string;
}

export class ScheduleGenerationRunQueryDto {
  @IsOptional() @IsString() @IsIn(['automatic', 'manual', 'configuration_change'])
  trigger?: ScheduleGenerationTrigger;
  @IsOptional() @IsString() @IsIn(['queued', 'running', 'retry_wait', 'succeeded', 'failed'])
  status?: ScheduleGenerationRunStatus;
  @ApiPropertyOptional({ type: String, format: 'date' }) @IsOptional() @IsString() @Matches(serviceDate)
  serviceDate?: string;
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ type: Number, default: 25, minimum: 1, maximum: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}

export class ScheduleGenerationRunCountsResponseDto {
  @ApiProperty({ type: Number, minimum: 0 }) created!: number;
  @ApiProperty({ type: Number, minimum: 0 }) existing!: number;
  @ApiProperty({ type: Number, minimum: 0 }) updated!: number;
  @ApiProperty({ type: Number, minimum: 0 }) cancelled!: number;
  @ApiProperty({ type: Number, minimum: 0 }) missingPrice!: number;
}

export class ScheduleGenerationRunResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['automatic', 'manual', 'configuration_change'] }) trigger!: ScheduleGenerationTrigger;
  @ApiProperty({ type: String, format: 'date' }) triggerLocalDate!: string;
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ enum: ['queued', 'running', 'retry_wait', 'succeeded', 'failed'] }) status!: ScheduleGenerationRunStatus;
  @ApiProperty({ type: Number, minimum: 0 }) attempt!: number;
  @ApiProperty({ type: Number, minimum: 1 }) maxAttempts!: number;
  @ApiProperty({ type: String, format: 'date-time' }) availableAt!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) startedAt?: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) finishedAt?: string;
  @ApiPropertyOptional({ type: String }) failureCode?: string;
  @ApiPropertyOptional({ type: String }) failureMessage?: string;
  @ApiPropertyOptional({ type: () => ScheduleGenerationRunCountsResponseDto }) counts?: ScheduleGenerationRunCountsResponseDto;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

export class ScheduleGenerationRunListResponseDto {
  @ApiProperty({ type: () => ScheduleGenerationRunResponseDto, isArray: true }) items!: ScheduleGenerationRunResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}

const counts = (value: ScheduleGenerationRunCounts): ScheduleGenerationRunCountsResponseDto => ({ ...value });

export const toScheduleGenerationRunResponse = (value: ScheduleGenerationRun): ScheduleGenerationRunResponseDto => ({
  id: value.id, trigger: value.trigger, triggerLocalDate: value.triggerLocalDate,
  serviceDate: value.serviceDate, status: value.status, attempt: value.attempt,
  maxAttempts: value.maxAttempts, availableAt: value.availableAt.toISOString(),
  ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt.toISOString() }),
  ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt.toISOString() }),
  ...(value.failureCode === undefined ? {} : { failureCode: value.failureCode }),
  ...(value.failureMessage === undefined ? {} : { failureMessage: value.failureMessage }),
  ...(value.counts === undefined ? {} : { counts: counts(value.counts) }),
  createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(),
});
