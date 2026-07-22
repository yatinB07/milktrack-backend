import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

import type { DeliveryDetail, DeliveryEvent, DeliveryPriceSnapshot, DeliveryRecord } from '../application/delivery.store.js';

const statuses = ['scheduled', 'cancelled', 'delivered', 'skipped_by_customer', 'skipped_by_agent', 'missed'] as const;
const date = /^\d{4}-\d{2}-\d{2}$/;

export class DeliveryPageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class VendorDeliveryPageQueryDto extends DeliveryPageQueryDto {
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(date) serviceDate?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('4') householdId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('4') routeId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('4') agentMembershipId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('4') productId?: string;
  @ApiPropertyOptional({ enum: statuses }) @IsOptional() @IsIn(statuses) currentStatus?: typeof statuses[number];
}

export class DeliverySummaryResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) householdId!: string;
  @ApiProperty({ format: 'uuid' }) subscriptionId!: string;
  @ApiProperty({ format: 'date' }) serviceDate!: string;
  plannedQuantity!: string;
  @ApiPropertyOptional() actualQuantity?: string;
  @ApiProperty({ enum: statuses }) currentStatus!: typeof statuses[number];
  version!: number;
  @ApiPropertyOptional({ format: 'date-time' }) finalizedAt?: string;
}

export class DeliveryPriceSnapshotResponseDto {
  amountMinor!: string;
  currency!: string;
  @ApiProperty({ enum: ['global', 'customer_specific'] }) pricingLevel!: 'global' | 'customer_specific';
  @ApiProperty({ format: 'uuid' }) sourcePriceId!: string;
  @ApiProperty({ enum: ['global_price', 'customer_price_override'] }) sourcePriceType!: 'global_price' | 'customer_price_override';
  @ApiProperty({ format: 'date-time' }) resolvedAt!: string;
}

export class DeliveryEventResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: statuses }) eventType!: string;
  @ApiProperty({ enum: ['system', 'customer', 'delivery_agent', 'vendor_admin'] }) source!: string;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ format: 'date-time' }) receivedAt!: string;
  @ApiPropertyOptional() actualQuantity?: string;
  @ApiPropertyOptional() reasonCode?: string;
  @ApiPropertyOptional() note?: string;
  @ApiPropertyOptional({ format: 'uuid' }) replacedEventId?: string;
}

export class VendorDeliveryEventResponseDto extends DeliveryEventResponseDto {
  @ApiPropertyOptional() latitude?: string;
  @ApiPropertyOptional() longitude?: string;
}

export class VendorDeliveryDetailResponseDto extends DeliverySummaryResponseDto {
  @ApiProperty({ type: () => VendorDeliveryEventResponseDto, isArray: true }) events!: VendorDeliveryEventResponseDto[];
  @ApiPropertyOptional({ type: () => DeliveryPriceSnapshotResponseDto }) snapshot?: DeliveryPriceSnapshotResponseDto;
}

export class CustomerDeliveryDetailResponseDto extends DeliverySummaryResponseDto {
  @ApiProperty({ type: () => DeliveryEventResponseDto, isArray: true }) events!: DeliveryEventResponseDto[];
  @ApiPropertyOptional({ type: () => DeliveryPriceSnapshotResponseDto }) snapshot?: DeliveryPriceSnapshotResponseDto;
}

export class DeliveryListResponseDto { @ApiProperty({ type: () => DeliverySummaryResponseDto, isArray: true }) items!: DeliverySummaryResponseDto[]; @ApiPropertyOptional() nextCursor?: string; }

export const toDeliverySummaryResponse = (value: DeliveryRecord): DeliverySummaryResponseDto => ({
  id: value.id, householdId: value.householdId, subscriptionId: value.subscriptionId, serviceDate: value.serviceDate,
  plannedQuantity: value.plannedQuantity, currentStatus: value.currentStatus, version: value.version,
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
export const toCustomerDeliveryDetailResponse = (value: DeliveryDetail): CustomerDeliveryDetailResponseDto => ({ ...toDeliverySummaryResponse(value), events: value.events.map(toEvent), ...(value.snapshot ? { snapshot: toSnapshot(value.snapshot) } : {}) });
