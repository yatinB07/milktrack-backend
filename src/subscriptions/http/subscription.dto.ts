import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { DateTime } from 'luxon';

import type { CustomerSubscriptionResult, SubscriptionResult } from '../application/subscription.service.js';
import type { CustomerSubscriptionRevision, SubscriptionRevisionRecord } from '../application/subscription.store.js';
import { LifecycleQueryDto } from '../../common/http/record-lifecycle.dto.js';
import { recordLifecycles } from '../../common/application/record-lifecycle.js';

const date = /^\d{4}-\d{2}-\d{2}$/;
const quantity = /^\d+(?:\.\d{1,3})?$/;
const statuses = ['future', 'active', 'paused', 'cancelled', 'completed'] as const;

export class SubscriptionPageQueryDto extends LifecycleQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() householdId?: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() deliverySlotId?: string;
  @ApiPropertyOptional({ type: String, enum: statuses }) @IsOptional() @IsIn(statuses) status?: typeof statuses[number];
  @ApiPropertyOptional({ type: String, format: 'uuid' }) @IsOptional() @IsUUID() routeId?: string;
  @ApiPropertyOptional({ type: String, format: 'date' }) @IsOptional() @Matches(date) routeServiceDate?: string;
}
export class SubscriptionHistoryQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class CustomerSubscriptionPageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() deliverySlotId?: string;
  @ApiPropertyOptional({ type: String, enum: statuses }) @IsOptional() @IsIn(statuses) status?: typeof statuses[number];
}
export class CustomerSubscriptionDetailQueryDto {}
export class CreateSubscriptionRequestDto {
  @IsUUID() householdId!: string; @IsUUID() productId!: string; @IsUUID() unitId!: string; @IsUUID() deliverySlotId!: string;
  @ApiProperty({ type: String, pattern: quantity.source }) @IsString() @Matches(quantity) quantity!: string;
  @ApiProperty({ type: [Number], minimum: 1, maximum: 7, minItems: 1, uniqueItems: true })
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) weekdays!: number[];
  @ApiProperty({ type: String, format: 'date' }) @Matches(date) startDate!: string;
  @ApiPropertyOptional({ type: String, format: 'date' }) @IsOptional() @Matches(date) endDate?: string;
}
export class ModifySubscriptionRequestDto {
  @IsUUID() productId!: string; @IsUUID() unitId!: string; @IsUUID() deliverySlotId!: string;
  @ApiProperty({ type: String, pattern: quantity.source }) @IsString() @Matches(quantity) quantity!: string;
  @ApiProperty({ type: [Number], minimum: 1, maximum: 7, minItems: 1, uniqueItems: true })
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) weekdays!: number[];
  @ApiProperty({ type: String, format: 'date' }) @Matches(date) effectiveDate!: string;
  @ApiPropertyOptional({ type: String, format: 'date' }) @IsOptional() @Matches(date) endDate?: string;
  @IsInt() @Min(1) expectedVersion!: number;
  @IsString() @Length(1, 500) reason!: string;
}
export class SubscriptionTransitionRequestDto {
  @ApiProperty({ type: String, format: 'date' }) @Matches(date) effectiveDate!: string;
  @IsInt() @Min(1) expectedVersion!: number;
  @IsString() @Length(1, 500) reason!: string;
}
export class SubscriptionVersionReasonRequestDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsString() @Length(1, 500) reason!: string;
}
export class SubscriptionRevisionResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) productId!: string; @ApiProperty({ type: String, format: 'uuid' }) unitId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string; @ApiProperty({ type: String }) quantity!: string; @ApiProperty({ type: [Number] }) weekdays!: number[];
  @ApiProperty({ type: String, enum: ['active', 'paused', 'cancelled'] }) status!: string; @ApiProperty({ type: String, format: 'date' }) startDate!: string;
  @ApiPropertyOptional({ type: String, format: 'date' }) endDate?: string; @ApiProperty({ type: String, format: 'uuid' }) createdBy!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) supersededAt?: string; @ApiPropertyOptional({ type: String, format: 'uuid' }) supersededByRevisionId?: string;
  @ApiPropertyOptional({ type: String }) supersessionReason?: string; @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string; @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class CustomerSubscriptionRevisionResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) productId!: string; @ApiProperty({ type: String, format: 'uuid' }) unitId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string; @ApiProperty({ type: String }) quantity!: string; @ApiProperty({ type: [Number] }) weekdays!: number[];
  @ApiProperty({ type: String, enum: ['active', 'paused', 'cancelled'] }) status!: string; @ApiProperty({ type: String, format: 'date' }) startDate!: string;
  @ApiPropertyOptional({ type: String, format: 'date' }) endDate?: string; @ApiPropertyOptional({ type: String, format: 'date-time' }) supersededAt?: string;
  @ApiPropertyOptional({ type: String, format: 'uuid' }) supersededByRevisionId?: string; @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class SubscriptionResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string; @ApiProperty({ type: String, format: 'uuid' }) householdId!: string;
  version!: number; @ApiProperty({ type: String, enum: statuses }) status!: string; @ApiPropertyOptional({ type: Number }) supersededRevisionCount?: number;
  @ApiProperty({ enum: recordLifecycles }) lifecycle!: string;
  @ApiProperty({ type: () => SubscriptionRevisionResponseDto, isArray: true }) revisions!: SubscriptionRevisionResponseDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string; @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class CustomerSubscriptionResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string; @ApiProperty({ type: String, format: 'uuid' }) householdId!: string;
  version!: number; @ApiProperty({ type: String, enum: statuses }) status!: string;
  @ApiProperty({ type: () => CustomerSubscriptionRevisionResponseDto, isArray: true }) revisions!: CustomerSubscriptionRevisionResponseDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string; @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class SubscriptionListResponseDto { @ApiProperty({ type: () => SubscriptionResponseDto, isArray: true }) items!: SubscriptionResponseDto[]; @ApiPropertyOptional({ type: String }) nextCursor?: string; }
export class CustomerSubscriptionListResponseDto { @ApiProperty({ type: () => CustomerSubscriptionResponseDto, isArray: true }) items!: CustomerSubscriptionResponseDto[]; @ApiPropertyOptional({ type: String }) nextCursor?: string; }
export class SubscriptionHistoryResponseDto { @ApiProperty({ type: () => SubscriptionRevisionResponseDto, isArray: true }) items!: SubscriptionRevisionResponseDto[]; @ApiPropertyOptional({ type: String }) nextCursor?: string; }
export class CustomerSubscriptionHistoryResponseDto { @ApiProperty({ type: () => CustomerSubscriptionRevisionResponseDto, isArray: true }) items!: CustomerSubscriptionRevisionResponseDto[]; @ApiPropertyOptional({ type: String }) nextCursor?: string; }

export function toSubscriptionRevisionResponse(value: SubscriptionRevisionRecord): SubscriptionRevisionResponseDto {
  const { effectiveFrom, effectiveTo, supersededAt, ...revision } = value;
  return { ...revision, weekdays: [...value.weekdays], startDate: effectiveFrom, ...(effectiveTo ? { endDate: inclusiveEndDate(effectiveTo) } : {}), ...(supersededAt ? { supersededAt: supersededAt.toISOString() } : {}), createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() };
}
export function toCustomerSubscriptionRevisionResponse(value: CustomerSubscriptionRevision): CustomerSubscriptionRevisionResponseDto {
  const { effectiveFrom, effectiveTo, supersededAt, ...revision } = value;
  return { ...revision, weekdays: [...value.weekdays], startDate: effectiveFrom, ...(effectiveTo ? { endDate: inclusiveEndDate(effectiveTo) } : {}), ...(supersededAt ? { supersededAt: supersededAt.toISOString() } : {}), createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() };
}
export function toSubscriptionResponse(value: SubscriptionResult): SubscriptionResponseDto {
  return { id: value.id, vendorId: value.vendorId, householdId: value.householdId, version: value.version, status: value.status, lifecycle: value.lifecycle,
    ...(value.supersededRevisionCount === undefined ? {} : { supersededRevisionCount: value.supersededRevisionCount }), revisions: value.revisions.map(toSubscriptionRevisionResponse),
    createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() };
}
export function toCustomerSubscriptionResponse(value: CustomerSubscriptionResult): CustomerSubscriptionResponseDto {
  return { id: value.id, vendorId: value.vendorId, householdId: value.householdId, version: value.version, status: value.status,
    revisions: value.revisions.map(toCustomerSubscriptionRevisionResponse), createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() };
}

function inclusiveEndDate(exclusiveEndDate: string): string {
  return DateTime.fromISO(exclusiveEndDate, { zone: 'UTC' }).minus({ days: 1 }).toISODate()!;
}
