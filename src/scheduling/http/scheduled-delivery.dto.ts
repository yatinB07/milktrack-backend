import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import type { AgentScheduledDelivery, ScheduledDeliveryRecord } from '../application/scheduled-delivery.store.js';

export class AgentScheduledDeliveryQueryDto {
  @ApiPropertyOptional({ type: String, format: 'date' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) serviceDate?: string;
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ScheduledDeliveryResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) subscriptionId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) householdId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) productId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) unitId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) routeAssignmentId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) routeStopId!: string;
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ type: String, example: '1.25' }) plannedQuantity!: string;
  @ApiProperty({ type: Number, minimum: 1 }) sequence!: number;
  @ApiProperty({ type: String, format: 'uuid' }) routeId!: string;
  routeCode!: string;
  routeName!: string;
  householdAccountNumber!: string;
  householdName!: string;
  addressLine1!: string;
  @ApiPropertyOptional({ type: String }) addressLine2?: string;
  @ApiPropertyOptional({ type: String }) locality?: string;
  city!: string;
  region!: string;
  postalCode!: string;
  countryCode!: string;
  productCode!: string;
  productName!: string;
  unitCode!: string;
  unitName!: string;
  deliverySlotName!: string;
  deliverySlotStartLocalTime!: string;
  deliverySlotEndLocalTime!: string;
}

export class ScheduledDeliveryListResponseDto {
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ type: () => ScheduledDeliveryResponseDto, isArray: true })
  items!: ScheduledDeliveryResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}

export const toScheduledDeliveryResponse = (
  value: ScheduledDeliveryRecord,
): ScheduledDeliveryResponseDto => {
  assertAgentScheduledDelivery(value);
  return ({
  id: value.id,
  subscriptionId: value.subscriptionId,
  householdId: value.householdId,
  productId: value.productId,
  unitId: value.unitId,
  deliverySlotId: value.deliverySlotId,
  routeAssignmentId: value.routeAssignmentId,
  routeStopId: value.routeStopId,
  serviceDate: value.serviceDate,
  plannedQuantity: value.plannedQuantity,
  sequence: value.sequence,
  routeId: value.routeId,
  routeCode: value.routeCode,
  routeName: value.routeName,
  householdAccountNumber: value.householdAccountNumber,
  householdName: value.householdName,
  addressLine1: value.addressLine1,
  ...(value.addressLine2 ? { addressLine2: value.addressLine2 } : {}),
  ...(value.locality ? { locality: value.locality } : {}),
  city: value.city,
  region: value.region,
  postalCode: value.postalCode,
  countryCode: value.countryCode,
  productCode: value.productCode,
  productName: value.productName,
  unitCode: value.unitCode,
  unitName: value.unitName,
  deliverySlotName: value.deliverySlotName,
  deliverySlotStartLocalTime: value.deliverySlotStartLocalTime,
  deliverySlotEndLocalTime: value.deliverySlotEndLocalTime,
  });
};

function assertAgentScheduledDelivery(value: ScheduledDeliveryRecord): asserts value is AgentScheduledDelivery {
  const required = ['routeId', 'routeCode', 'routeName', 'householdAccountNumber', 'householdName', 'addressLine1', 'city', 'region', 'postalCode', 'countryCode', 'productCode', 'productName', 'unitCode', 'unitName', 'deliverySlotName', 'deliverySlotStartLocalTime', 'deliverySlotEndLocalTime'] as const;
  for (const key of required) {
    if (typeof (value as Record<string, unknown>)[key] !== 'string') throw new TypeError(`Agent scheduled delivery is missing ${key}`);
  }
}
