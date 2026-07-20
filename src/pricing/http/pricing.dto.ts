import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import type { OverrideRecord, PriceRecord } from '../application/pricing.store.js';

const amount = /^(?:0|[1-9]\d*)$/;
export class PricePageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() unitId?: string;
}
export class CreatePriceRequestDto {
  @IsUUID() productId!: string;
  @IsUUID() unitId!: string;
  @ApiProperty({ type: String, pattern: amount.source }) @IsString() @Matches(amount) amountMinor!: string;
  @ApiProperty({ type: String, format: 'date-time' }) @IsDateString({ strict: true }) effectiveFrom!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) @IsOptional() @IsDateString({ strict: true }) effectiveTo?: string;
}
export class CreateOverrideRequestDto extends CreatePriceRequestDto { @IsString() @Length(1, 500) reason!: string; }
export class ClosePriceRequestDto {
  @ApiProperty({ type: String, format: 'date-time' }) @IsDateString({ strict: true }) effectiveTo!: string;
  @IsString() @Length(1, 500) reason!: string;
}
export class ResolveVendorPriceQueryDto {
  @IsUUID() householdId!: string; @IsUUID() productId!: string; @IsUUID() unitId!: string; @IsUUID() deliverySlotId!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) serviceDate!: string;
}
export class ResolveCustomerPriceQueryDto {
  @IsUUID() productId!: string; @IsUUID() unitId!: string; @IsUUID() deliverySlotId!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) serviceDate!: string;
}
export class PriceResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) productId!: string; @ApiProperty({ type: String, format: 'uuid' }) unitId!: string;
  @ApiProperty({ type: String, pattern: amount.source }) amountMinor!: string; currency!: string;
  @ApiProperty({ type: String, format: 'date-time' }) effectiveFrom!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) effectiveTo!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string; @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class OverrideResponseDto extends PriceResponseDto { @ApiProperty({ type: String, format: 'uuid' }) householdId!: string; reason!: string; }
export class PriceListResponseDto { @ApiProperty({ type: () => PriceResponseDto, isArray: true }) items!: PriceResponseDto[]; @ApiPropertyOptional({ type: String }) nextCursor?: string; }
export class OverrideListResponseDto { @ApiProperty({ type: () => OverrideResponseDto, isArray: true }) items!: OverrideResponseDto[]; @ApiPropertyOptional({ type: String }) nextCursor?: string; }
export class ResolvedPriceResponseDto { @ApiProperty({ type: String, enum: ['resolved', 'missing'] }) status!: string; @ApiPropertyOptional({ type: String }) amountMinor?: string; @ApiPropertyOptional({ type: String }) currency?: string; @ApiPropertyOptional({ type: String, enum: ['customer_specific', 'global'] }) source?: string; @ApiPropertyOptional({ type: String, format: 'uuid' }) sourcePriceId?: string; }
export class CustomerResolvedPriceResponseDto { @ApiProperty({ type: String, enum: ['resolved', 'missing'] }) status!: string; @ApiPropertyOptional({ type: String }) amountMinor?: string; @ApiPropertyOptional({ type: String }) currency?: string; @ApiPropertyOptional({ type: String, enum: ['customer_specific', 'global'] }) source?: string; }

export const toPriceResponse = (value: PriceRecord): PriceResponseDto => ({ ...value, effectiveFrom: value.effectiveFrom.toISOString(), effectiveTo: value.effectiveTo?.toISOString() ?? null, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() });
export const toOverrideResponse = (value: OverrideRecord): OverrideResponseDto => ({ ...toPriceResponse(value), householdId: value.householdId, reason: value.reason });
