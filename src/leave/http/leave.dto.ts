import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

import type { LeaveDecisionPage, LeaveDecisionResult, LeavePreviewResult, LeaveRequestPage, LeaveRequestResult, VendorLeaveRequestResult } from '../application/leave.service.js';

const date = /^\d{4}-\d{2}-\d{2}$/;
const requestStatuses = ['pending_approval', 'partially_pending', 'accepted', 'rejected', 'cancelled'] as const;
const decisionStatuses = ['pending', 'approved', 'rejected'] as const;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

class PageQueryDto {
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ type: Number, default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
class LeaveSelectionDto {
  @ApiProperty({ type: String, format: 'date' }) @Matches(date) startDate!: string;
  @ApiProperty({ type: String, format: 'date' }) @Matches(date) endDate!: string;
  @ApiProperty({ type: [String], format: 'uuid', minItems: 1, uniqueItems: true }) @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsUUID('4', { each: true }) subscriptionIds!: string[];
  @ApiPropertyOptional({ type: String }) @IsOptional() @Transform(trim) @IsString() @Length(1, 500) note?: string;
}
export class CustomerLeavePreviewRequestDto extends LeaveSelectionDto {
  @ApiPropertyOptional({ type: String, description: 'Opaque cursor for stable occurrence ordering with an ID tie-breaker.' }) @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ type: Number, default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class CreateCustomerLeaveRequestDto extends LeaveSelectionDto {}
export class AmendCustomerLeaveRequestDto extends LeaveSelectionDto { @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number; }
export class CancelCustomerLeaveRequestDto { @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number; @ApiPropertyOptional({ type: String }) @IsOptional() @Transform(trim) @IsString() @Length(1, 500) note?: string; }
export class CustomerLeavePageQueryDto extends PageQueryDto {}
export class VendorLeaveDecisionPageQueryDto extends PageQueryDto {}
export class DecideLeaveOccurrenceRequestDto { @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number; @IsIn(['approved', 'rejected']) decision!: 'approved' | 'rejected'; @Transform(trim) @IsString() @Length(3, 500) reason!: string; }

export class LeaveOccurrenceResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) subscriptionId!: string; @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string;
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string; @ApiProperty({ type: String, format: 'date-time' }) cutoffAt!: string;
  @ApiProperty({ enum: ['on_time', 'late'] }) timing!: string; @ApiProperty({ enum: ['accept', 'pending_approval', 'reject'] }) proposedBehavior!: string;
}
export class CustomerLeavePreviewResponseDto {
  timezone!: string; skipCutoffMinutes!: number; @ApiProperty({ enum: ['reject', 'approval'] }) lateLeavePolicy!: string;
  onTimeCount!: number; lateCount!: number; @ApiProperty({ type: () => LeaveOccurrenceResponseDto, isArray: true }) items!: LeaveOccurrenceResponseDto[]; @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
export class CustomerLeaveDecisionTimelineResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) subscriptionId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string; @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ enum: decisionStatuses }) currentStatus!: string; @ApiProperty({ enum: ['scheduled', 'skipped_by_customer'] }) previousEffectiveStatus!: string;
  @ApiProperty({ enum: ['scheduled', 'skipped_by_customer'] }) requestedEffectiveStatus!: string; @ApiPropertyOptional({ type: String, format: 'uuid' }) decidedBy?: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) decidedAt?: string; @ApiPropertyOptional({ type: String }) decisionReason?: string;
  version!: number; @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
export class CustomerLeaveRevisionResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ enum: ['create', 'amend', 'cancel'] }) action!: string;
  @ApiProperty({ type: String, format: 'date' }) startDate!: string; @ApiProperty({ type: String, format: 'date' }) endDate!: string; @ApiProperty({ enum: requestStatuses }) currentStatus!: string;
  @ApiProperty({ enum: ['customer', 'vendor_admin', 'system'] }) source!: string; @ApiProperty({ type: String, format: 'uuid' }) createdBy!: string;
  @ApiPropertyOptional({ type: String }) note?: string; @ApiProperty({ type: [String], format: 'uuid' }) subscriptionIds!: string[];
  @ApiProperty({ type: () => CustomerLeaveDecisionTimelineResponseDto, isArray: true }) decisions!: CustomerLeaveDecisionTimelineResponseDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
export class CustomerLeaveDetailResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string; @ApiProperty({ type: String, format: 'uuid' }) householdId!: string;
  @ApiProperty({ enum: requestStatuses }) currentStatus!: string; version!: number; @ApiPropertyOptional({ type: String, format: 'uuid' }) currentRevisionId?: string;
  @ApiProperty({ enum: ['amend', 'cancel'], isArray: true }) availableActions!: string[];
  @ApiProperty({ type: () => CustomerLeaveRevisionResponseDto, isArray: true }) revisions!: CustomerLeaveRevisionResponseDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string; @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
const stableCursorDescription = 'Opaque cursor for stable ordering with an ID tie-breaker.';
export class CustomerLeaveListResponseDto { @ApiProperty({ type: () => CustomerLeaveDetailResponseDto, isArray: true }) items!: CustomerLeaveDetailResponseDto[]; @ApiPropertyOptional({ type: String, description: stableCursorDescription }) nextCursor?: string; }
export class VendorLeaveDecisionTimelineResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) subscriptionId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string; @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ enum: decisionStatuses }) currentStatus!: string; @ApiProperty({ enum: ['scheduled', 'skipped_by_customer'] }) previousEffectiveStatus!: string;
  @ApiProperty({ enum: ['scheduled', 'skipped_by_customer'] }) requestedEffectiveStatus!: string; @ApiPropertyOptional({ type: String, format: 'uuid' }) decidedBy?: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) decidedAt?: string; @ApiPropertyOptional({ type: String }) decisionReason?: string;
  version!: number; @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ enum: ['approve', 'reject'], isArray: true }) availableActions!: string[];
}
export class VendorLeaveRevisionResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ enum: ['create', 'amend', 'cancel'] }) action!: string;
  @ApiProperty({ type: String, format: 'date' }) startDate!: string; @ApiProperty({ type: String, format: 'date' }) endDate!: string; @ApiProperty({ enum: requestStatuses }) currentStatus!: string;
  @ApiProperty({ enum: ['customer', 'vendor_admin', 'system'] }) source!: string; @ApiProperty({ type: String, format: 'uuid' }) createdBy!: string;
  @ApiPropertyOptional({ type: String }) note?: string; @ApiProperty({ type: [String], format: 'uuid' }) subscriptionIds!: string[];
  @ApiProperty({ type: () => VendorLeaveDecisionTimelineResponseDto, isArray: true }) decisions!: VendorLeaveDecisionTimelineResponseDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
export class VendorLeaveRequestDetailResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string; @ApiProperty({ type: String, format: 'uuid' }) householdId!: string;
  @ApiProperty({ enum: requestStatuses }) currentStatus!: string; version!: number; @ApiPropertyOptional({ type: String, format: 'uuid' }) currentRevisionId?: string;
  @ApiProperty({ type: () => VendorLeaveRevisionResponseDto, isArray: true }) revisions!: VendorLeaveRevisionResponseDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string; @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class VendorLeaveDecisionResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) leaveRequestRevisionId!: string; @ApiProperty({ type: String, format: 'uuid' }) subscriptionId!: string; @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string;
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string; @ApiProperty({ enum: decisionStatuses }) currentStatus!: string; version!: number; @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
export class VendorLeaveDecisionListResponseDto { @ApiProperty({ type: () => VendorLeaveDecisionResponseDto, isArray: true }) items!: VendorLeaveDecisionResponseDto[]; @ApiPropertyOptional({ type: String, description: stableCursorDescription }) nextCursor?: string; }
export class VendorLeaveDecisionResponseEnvelopeDto extends VendorLeaveDecisionResponseDto { @ApiProperty({ type: () => VendorLeaveRequestDetailResponseDto }) request!: VendorLeaveRequestDetailResponseDto; }

export function toCustomerLeaveRequestResponse(value: LeaveRequestResult): CustomerLeaveDetailResponseDto {
  return {
    id: value.id, vendorId: value.vendorId, householdId: value.householdId, currentStatus: value.currentStatus, version: value.version,
    ...(value.currentRevisionId ? { currentRevisionId: value.currentRevisionId } : {}), availableActions: [...value.availableActions],
    revisions: value.revisions.map(({ id, action, startDate, endDate, source, createdBy, status, note, subscriptionIds, decisions, createdAt }) => ({
      id, action, startDate, endDate, source, createdBy, currentStatus: status, ...(note ? { note } : {}), subscriptionIds: [...subscriptionIds],
      decisions: (decisions ?? []).map((item) => ({ id: item.id, subscriptionId: item.subscriptionId, deliverySlotId: item.deliverySlotId,
        serviceDate: item.serviceDate, currentStatus: item.status, previousEffectiveStatus: item.previousEffectiveStatus,
        requestedEffectiveStatus: item.requestedEffectiveStatus, ...(item.decidedBy ? { decidedBy: item.decidedBy } : {}),
        ...(item.decidedAt ? { decidedAt: item.decidedAt.toISOString() } : {}), ...(item.decisionReason ? { decisionReason: item.decisionReason } : {}),
        version: item.version, createdAt: item.createdAt.toISOString() })), createdAt: createdAt.toISOString(),
    })),
    createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(),
  };
}
export function toVendorLeaveRequestResponse(value: VendorLeaveRequestResult): VendorLeaveRequestDetailResponseDto {
  return {
    id: value.id, vendorId: value.vendorId, householdId: value.householdId, currentStatus: value.currentStatus, version: value.version,
    ...(value.currentRevisionId ? { currentRevisionId: value.currentRevisionId } : {}),
    revisions: value.revisions.map(({ id, action, startDate, endDate, source, createdBy, status, note, subscriptionIds, decisions, createdAt }) => ({
      id, action, startDate, endDate, source, createdBy, currentStatus: status, ...(note ? { note } : {}), subscriptionIds: [...subscriptionIds],
      decisions: (decisions ?? []).map((item) => ({ id: item.id, subscriptionId: item.subscriptionId, deliverySlotId: item.deliverySlotId,
        serviceDate: item.serviceDate, currentStatus: item.status, previousEffectiveStatus: item.previousEffectiveStatus,
        requestedEffectiveStatus: item.requestedEffectiveStatus, ...(item.decidedBy ? { decidedBy: item.decidedBy } : {}),
        ...(item.decidedAt ? { decidedAt: item.decidedAt.toISOString() } : {}), ...(item.decisionReason ? { decisionReason: item.decisionReason } : {}),
        version: item.version, createdAt: item.createdAt.toISOString(), availableActions: [...item.availableActions] })), createdAt: createdAt.toISOString(),
    })),
    createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(),
  };
}
export function toLeavePageResponse(value: LeaveRequestPage): CustomerLeaveListResponseDto { return { items: value.items.map(toCustomerLeaveRequestResponse), ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) }; }
export function toLeavePreviewResponse(value: LeavePreviewResult): CustomerLeavePreviewResponseDto { return { timezone: value.timezone, skipCutoffMinutes: value.skipCutoffMinutes, lateLeavePolicy: value.lateLeavePolicy, onTimeCount: value.onTimeCount, lateCount: value.lateCount, items: value.items.map((item) => ({ ...item, cutoffAt: item.cutoffAt.toISOString() })), ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) }; }
export function toDecisionPageResponse(value: LeaveDecisionPage): VendorLeaveDecisionListResponseDto { return { items: value.items.map(toDecisionResponse), ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) }; }
export function toDecisionResponse(value: LeaveDecisionPage['items'][number] | LeaveDecisionResult): VendorLeaveDecisionResponseDto { return { id: value.id, leaveRequestRevisionId: value.leaveRequestRevisionId, subscriptionId: value.subscriptionId, deliverySlotId: value.deliverySlotId, serviceDate: value.serviceDate, currentStatus: value.currentStatus, version: value.version, createdAt: value.createdAt.toISOString() }; }
export function toDecisionResultResponse(value: LeaveDecisionResult): VendorLeaveDecisionResponseEnvelopeDto { return { ...toDecisionResponse(value), request: toVendorLeaveRequestResponse(value.request) }; }
