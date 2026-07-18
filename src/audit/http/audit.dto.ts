import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { AuditEventResult } from '../application/list-audit-events.js';

const PROHIBITED_KEY_PARTS = [
  'password',
  'otp',
  'token',
  'secret',
  'iphash',
  'deviceid',
  'authenticationmethod',
] as const;

export class ListAuditEventsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  action?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  entityType?: string;

  @IsOptional()
  @IsUUID('4')
  entityId?: string;
}

export class AuditEventResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  actorUserId!: string;

  @ApiProperty({ type: String })
  action!: string;

  @ApiProperty({ type: String })
  entityType!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  entityId!: string;

  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  oldValue?: unknown;

  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  newValue?: unknown;

  @ApiPropertyOptional({ type: String })
  reason?: string;

  @ApiProperty({ type: String, format: 'uuid' })
  correlationId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class AuditEventListResponseDto {
  @ApiProperty({ type: () => AuditEventResponseDto, isArray: true })
  items!: AuditEventResponseDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
        return !PROHIBITED_KEY_PARTS.some((part) => normalized.includes(part));
      })
      .map(([key, nested]) => [key, redactAuditValue(nested)]),
  );
}

export function toAuditEventResponse(
  event: AuditEventResult,
): AuditEventResponseDto {
  return {
    id: event.id,
    vendorId: event.vendorId,
    actorUserId: event.actorUserId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    ...(event.oldValue === undefined
      ? {}
      : { oldValue: redactAuditValue(event.oldValue) }),
    ...(event.newValue === undefined
      ? {}
      : { newValue: redactAuditValue(event.newValue) }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    correlationId: event.correlationId,
    createdAt: event.createdAt.toISOString(),
  };
}
