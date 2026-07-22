import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsDefined, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateBy, ValidateIf, ValidateNested } from 'class-validator';

import type { AgentStopResult } from '../application/agent-stop-outcome.service.js';
import type { DeliveryDetail, DeliveryEvent, DeliveryPriceSnapshot, DeliveryRecord } from '../application/delivery.store.js';
import { AGENT_SKIP_REASONS, MISSED_REASONS } from '../domain/delivery-rules.js';

const statuses = ['scheduled', 'cancelled', 'delivered', 'skipped_by_customer', 'skipped_by_agent', 'missed'] as const;
const correctionStatuses = ['delivered', 'skipped_by_agent', 'missed'] as const;
const date = /^\d{4}-\d{2}-\d{2}$/;
const quantity = /^(?!0(?:\.0+)?$)(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IsOutcomeReason = () => ValidateBy({
  name: 'isOutcomeReason',
  validator: {
    validate: (reason: unknown, args) => {
      if (!args) return false;
      const { outcome } = args.object as AgentStopOutcomeRequestDto;
      if (outcome === 'delivered') return reason === undefined;
      return typeof reason === 'string'
        && (outcome === 'skipped_by_agent' ? AGENT_SKIP_REASONS : MISSED_REASONS).includes(reason as never);
    },
  },
});
const IsOutcomeItems = () => ValidateBy({
  name: 'isOutcomeItems',
  validator: {
    validate: (items: unknown, args) => Array.isArray(items) && items.every((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const actualQuantity = (item as { actualQuantity?: unknown }).actualQuantity;
      return (args?.object as AgentStopOutcomeRequestDto).outcome === 'delivered'
        ? typeof actualQuantity === 'string' && quantity.test(actualQuantity)
        : actualQuantity === undefined;
    }),
  },
});
const IsOutcomeNote = () => ValidateBy({
  name: 'isOutcomeNote',
  validator: {
    validate: (note: unknown, args) => {
      const { outcome, reasonCode } = args?.object as AgentStopOutcomeRequestDto;
      if (outcome === 'delivered') return note === undefined;
      return reasonCode !== 'other' || (typeof note === 'string' && note.length > 0);
    },
  },
});
const IsOutcomeCoordinatePair = () => ValidateBy({
  name: 'isOutcomeCoordinatePair',
  validator: {
    validate: (_latitude: unknown, args) => {
      const { outcome, latitude, longitude } = args?.object as AgentStopOutcomeRequestDto;
      if (outcome === 'delivered') return latitude === undefined && longitude === undefined;
      return (latitude === undefined) === (longitude === undefined);
    },
  },
});
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class AgentStopOutcomeItemDto {
  @ApiProperty({ type: String, format: 'uuid' }) @IsUUID('4') scheduledDeliveryId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) @Min(1) @IsInt() @Type(() => Number) expectedVersion!: number;
  @ApiPropertyOptional({ type: String, pattern: quantity.source }) @IsOptional() @IsString() @Matches(quantity) actualQuantity?: string;
}

export class AgentStopOutcomeRequestDto {
  @ApiProperty({ type: String, format: 'date' }) @Matches(date) serviceDate!: string;
  @ApiProperty({ type: String, enum: ['delivered', 'skipped_by_agent', 'missed'] }) @IsIn(['delivered', 'skipped_by_agent', 'missed']) outcome!: 'delivered' | 'skipped_by_agent' | 'missed';
  @ApiProperty({ type: String, format: 'date-time', pattern: rfc3339.source }) @Matches(rfc3339) occurredAt!: string;
  @ApiProperty({ type: () => AgentStopOutcomeItemDto, isArray: true, minItems: 1 }) @IsArray() @ArrayNotEmpty() @IsOutcomeItems() @ValidateNested({ each: true }) @Type(() => AgentStopOutcomeItemDto) items!: AgentStopOutcomeItemDto[];
  @ApiPropertyOptional({ type: String, enum: [...new Set([...AGENT_SKIP_REASONS, ...MISSED_REASONS])] })
  @IsOutcomeReason()
  reasonCode?: typeof AGENT_SKIP_REASONS[number] | typeof MISSED_REASONS[number];
  @ApiPropertyOptional({ type: String, maxLength: 500 }) @Transform(trim)
  @ValidateIf((value: AgentStopOutcomeRequestDto, note: unknown) => note !== undefined || value.reasonCode === 'other')
  @IsOutcomeNote() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ type: Number, minimum: -90, maximum: 90 })
  @IsOutcomeCoordinatePair()
  @ValidateIf((value: AgentStopOutcomeRequestDto) => value.latitude !== undefined || value.longitude !== undefined)
  @IsDefined() @IsNumber({ allowInfinity: false, allowNaN: false }) @Min(-90) @Max(90) latitude?: number;
  @ApiPropertyOptional({ type: Number, minimum: -180, maximum: 180 })
  @ValidateIf((value: AgentStopOutcomeRequestDto) => value.latitude !== undefined || value.longitude !== undefined)
  @IsDefined() @IsNumber({ allowInfinity: false, allowNaN: false }) @Min(-180) @Max(180) longitude?: number;
}

export class DeliveredStopOutcomeItemDto {
  @ApiProperty({ type: String, format: 'uuid' }) scheduledDeliveryId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) expectedVersion!: number;
  @ApiProperty({ type: String, pattern: quantity.source, description: 'Positive decimal quantity with at most three fractional digits.' }) actualQuantity!: string;
}
export class NonDeliveredStopOutcomeItemDto {
  @ApiProperty({ type: String, format: 'uuid' }) scheduledDeliveryId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) expectedVersion!: number;
}
class AgentStopOutcomeMetadataDto {
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string;
}
export class DeliveredAgentStopOutcomeDto extends AgentStopOutcomeMetadataDto {
  @ApiProperty({ type: String, enum: ['delivered'] }) outcome!: 'delivered';
  @ApiProperty({ type: () => DeliveredStopOutcomeItemDto, isArray: true, minItems: 1 }) items!: DeliveredStopOutcomeItemDto[];
}
export class SkippedAgentStopOutcomeDto extends AgentStopOutcomeMetadataDto {
  @ApiProperty({ type: String, enum: ['skipped_by_agent'] }) outcome!: 'skipped_by_agent';
  @ApiProperty({ type: 'array', minItems: 1, items: { allOf: [{ $ref: getSchemaPath(NonDeliveredStopOutcomeItemDto) }], not: { required: ['actualQuantity'] } } }) items!: NonDeliveredStopOutcomeItemDto[];
  @ApiProperty({ type: String, enum: AGENT_SKIP_REASONS, description: '`other` requires a non-empty trimmed note.' }) reasonCode!: typeof AGENT_SKIP_REASONS[number];
  @ApiPropertyOptional({ type: String, maxLength: 500 }) note?: string;
  @ApiPropertyOptional({ type: Number, minimum: -90, maximum: 90, description: 'Present with longitude or both coordinates are absent.' }) latitude?: number;
  @ApiPropertyOptional({ type: Number, minimum: -180, maximum: 180, description: 'Present with latitude or both coordinates are absent.' }) longitude?: number;
}
export class MissedAgentStopOutcomeDto extends AgentStopOutcomeMetadataDto {
  @ApiProperty({ type: String, enum: MISSED_REASONS, description: '`other` requires a non-empty trimmed note.' }) reasonCode!: typeof MISSED_REASONS[number];
  @ApiProperty({ type: String, enum: ['missed'] }) outcome!: 'missed';
  @ApiProperty({ type: 'array', minItems: 1, items: { allOf: [{ $ref: getSchemaPath(NonDeliveredStopOutcomeItemDto) }], not: { required: ['actualQuantity'] } } }) items!: NonDeliveredStopOutcomeItemDto[];
  @ApiPropertyOptional({ type: String, maxLength: 500 }) note?: string;
  @ApiPropertyOptional({ type: Number, minimum: -90, maximum: 90, description: 'Present with longitude or both coordinates are absent.' }) latitude?: number;
  @ApiPropertyOptional({ type: Number, minimum: -180, maximum: 180, description: 'Present with latitude or both coordinates are absent.' }) longitude?: number;
}

export class DeliveryPageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ type: Number, default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class CorrectDeliveryRequestDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsIn(correctionStatuses) replacementOutcome!: typeof correctionStatuses[number];
  @IsOptional() @IsString() @Matches(/^(?!0(?:\.0+)?$)(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u) actualQuantity?: string;
  @IsString() @Length(3, 500) @Matches(/^\S(?:.*\S)?$/u) reason!: string;
}

export class VendorDeliveryPageQueryDto extends DeliveryPageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'date' }) @IsOptional() @Matches(date) serviceDate?: string;
  @ApiPropertyOptional({ type: String, format: 'uuid' }) @IsOptional() @IsUUID('4') householdId?: string;
  @ApiPropertyOptional({ type: String, format: 'uuid' }) @IsOptional() @IsUUID('4') routeId?: string;
  @ApiPropertyOptional({ type: String, format: 'uuid' }) @IsOptional() @IsUUID('4') agentMembershipId?: string;
  @ApiPropertyOptional({ type: String, format: 'uuid' }) @IsOptional() @IsUUID('4') productId?: string;
  @ApiPropertyOptional({ type: String, enum: statuses }) @IsOptional() @IsIn(statuses) currentStatus?: typeof statuses[number];
}

export class DeliverySummaryResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) householdId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) subscriptionId!: string;
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ type: String, pattern: quantity.source }) plannedQuantity!: string;
  @ApiPropertyOptional({ type: String, pattern: quantity.source }) actualQuantity?: string;
  @ApiProperty({ type: String, enum: statuses }) currentStatus!: typeof statuses[number];
  version!: number;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) finalizedAt?: string;
}

export class DeliveryPriceSnapshotResponseDto {
  @ApiProperty({ type: String, pattern: '^\\d+$', description: 'Integer minor-unit amount serialized as a decimal string.' }) amountMinor!: string;
  currency!: string;
  @ApiProperty({ type: String, enum: ['global', 'customer_specific'] }) pricingLevel!: 'global' | 'customer_specific';
  @ApiProperty({ type: String, format: 'uuid' }) sourcePriceId!: string;
  @ApiProperty({ type: String, enum: ['global_price', 'customer_price_override'] }) sourcePriceType!: 'global_price' | 'customer_price_override';
  @ApiProperty({ type: String, format: 'date-time' }) resolvedAt!: string;
}

export class DeliveryEventResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, enum: ['delivered', 'skipped_by_customer', 'skipped_by_agent', 'missed'] }) eventType!: string;
  @ApiProperty({ type: String, enum: ['system', 'customer', 'delivery_agent', 'vendor_admin'] }) source!: string;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) receivedAt!: string;
  @ApiPropertyOptional({ type: String, pattern: quantity.source }) actualQuantity?: string;
  @ApiPropertyOptional({ type: String }) reasonCode?: string;
  @ApiPropertyOptional({ type: String }) note?: string;
  @ApiPropertyOptional({ type: String, format: 'uuid' }) replacedEventId?: string;
}

export class VendorDeliveryEventResponseDto extends DeliveryEventResponseDto {
  @ApiPropertyOptional({ type: String, pattern: '^-?(?:90(?:\\.0+)?|(?:[0-8]?\\d)(?:\\.\\d+)?)$', description: 'Latitude decimal string in [-90, 90], present only with longitude.' }) latitude?: string;
  @ApiPropertyOptional({ type: String, pattern: '^-?(?:180(?:\\.0+)?|(?:1[0-7]\\d|[0-9]?\\d)(?:\\.\\d+)?)$', description: 'Longitude decimal string in [-180, 180], present only with latitude.' }) longitude?: string;
}

export class VendorDeliveryDetailResponseDto extends DeliverySummaryResponseDto {
  @ApiProperty({ type: () => VendorDeliveryEventResponseDto, isArray: true }) events!: VendorDeliveryEventResponseDto[];
  @ApiPropertyOptional({ type: () => DeliveryPriceSnapshotResponseDto }) snapshot?: DeliveryPriceSnapshotResponseDto;
}

export class CustomerDeliveryDetailResponseDto extends DeliverySummaryResponseDto {
  @ApiProperty({ type: () => DeliveryEventResponseDto, isArray: true }) events!: DeliveryEventResponseDto[];
  @ApiPropertyOptional({ type: () => DeliveryPriceSnapshotResponseDto }) snapshot?: DeliveryPriceSnapshotResponseDto;
}

const stableCursorDescription = 'Opaque cursor for stable ordering with an ID tie-breaker.';
export class VendorDeliveryListResponseDto { @ApiProperty({ type: () => DeliverySummaryResponseDto, isArray: true }) items!: DeliverySummaryResponseDto[]; @ApiPropertyOptional({ type: String, description: stableCursorDescription }) nextCursor?: string; }
export class CustomerDeliveryListResponseDto { @ApiProperty({ type: () => DeliverySummaryResponseDto, isArray: true }) items!: DeliverySummaryResponseDto[]; @ApiPropertyOptional({ type: String, description: stableCursorDescription }) nextCursor?: string; }

export class AgentStopOutcomeResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) routeStopId!: string;
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ type: String, enum: ['delivered', 'skipped_by_agent', 'missed'] }) outcome!: 'delivered' | 'skipped_by_agent' | 'missed';
  @ApiProperty({ type: () => DeliverySummaryResponseDto, isArray: true }) items!: DeliverySummaryResponseDto[];
}

export const toDeliverySummaryResponse = (value: DeliveryRecord): DeliverySummaryResponseDto => ({
  id: value.id, householdId: value.householdId, subscriptionId: value.subscriptionId, serviceDate: value.serviceDate,
  plannedQuantity: value.plannedQuantity, currentStatus: value.currentStatus, version: value.version,
  ...(value.actualQuantity ? { actualQuantity: value.actualQuantity } : {}),
  ...(value.finalizedAt ? { finalizedAt: value.finalizedAt.toISOString() } : {}),
});

const toSnapshot = (value: DeliveryPriceSnapshot): DeliveryPriceSnapshotResponseDto => ({ ...value, resolvedAt: value.resolvedAt.toISOString() });
const toEvent = (value: DeliveryEvent): DeliveryEventResponseDto => ({
  id: value.id, eventType: value.eventType, source: value.source, occurredAt: value.occurredAt.toISOString(), receivedAt: value.receivedAt.toISOString(),
  ...(value.actualQuantity ? { actualQuantity: value.actualQuantity } : {}), ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}),
  ...(value.note ? { note: value.note } : {}), ...(value.replacedEventId ? { replacedEventId: value.replacedEventId } : {}),
});
const toVendorEvent = (value: DeliveryEvent): VendorDeliveryEventResponseDto => ({
  ...toEvent(value), ...(value.latitude ? { latitude: value.latitude } : {}), ...(value.longitude ? { longitude: value.longitude } : {}),
});

export const toVendorDeliveryDetailResponse = (value: DeliveryDetail): VendorDeliveryDetailResponseDto => ({ ...toDeliverySummaryResponse(value), events: value.events.map(toVendorEvent), ...(value.snapshot ? { snapshot: toSnapshot(value.snapshot) } : {}) });
const toCustomerEvent = (value: DeliveryEvent): DeliveryEventResponseDto => {
  const event = toEvent(value);
  if (value.source !== 'vendor_admin') return event;
  const { reasonCode, ...safe } = event;
  void reasonCode;
  return safe;
};
export const toCustomerDeliveryDetailResponse = (value: DeliveryDetail): CustomerDeliveryDetailResponseDto => ({ ...toDeliverySummaryResponse(value), events: value.events.map(toCustomerEvent), ...(value.snapshot ? { snapshot: toSnapshot(value.snapshot) } : {}) });
export const toAgentStopOutcomeResponse = (value: AgentStopResult): AgentStopOutcomeResponseDto => ({
  routeStopId: value.routeStopId, serviceDate: value.serviceDate, outcome: value.outcome,
  items: value.items.map(toDeliverySummaryResponse),
});
