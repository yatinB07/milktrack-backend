import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ProductResult } from '../application/catalog.service.js';
import type { DeliverySlotRecord, UnitRecord } from '../infrastructure/prisma-catalog.store.js';
import { type RecordLifecycle, recordLifecycles } from '../../common/application/record-lifecycle.js';

const code = /^[A-Za-z0-9_-]{2,32}$/;
const localTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export class CatalogPageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @ApiPropertyOptional({ enum: ['active', 'inactive'], default: 'active' }) @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
  @IsOptional() @IsString() @Length(1, 160) search?: string;
}
export class ProductPageQueryDto extends CatalogPageQueryDto {
  @ApiPropertyOptional({ enum: recordLifecycles, default: 'current' })
  @IsOptional()
  @IsIn(recordLifecycles)
  lifecycle?: RecordLifecycle;
}
export class CreateUnitRequestDto {
  @ApiProperty({ type: String, pattern: code.source }) @IsString() @Matches(code) code!: string;
  @IsString() @Length(1, 100) name!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(3) decimalScale!: number;
}
export class RenameUnitRequestDto { @IsString() @Length(1, 100) name!: string; }
export class ReasonRequestDto { @IsString() @Length(1, 500) reason!: string; }
export class CreateProductRequestDto {
  @ApiProperty({ type: String, pattern: code.source }) @IsString() @Matches(code) code!: string;
  @IsString() @Length(1, 160) name!: string;
  @ApiProperty({ type: String, format: 'uuid' }) @IsUUID() defaultUnitId!: string;
}
export class UpdateProductRequestDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsString() @Length(1, 160) name?: string;
  @ApiPropertyOptional({ enum: ['active', 'inactive'] }) @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
}
export class VersionedReasonRequestDto extends ReasonRequestDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}
export class RestoreProductRequestDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsString() @Length(1, 500) reason?: string;
}
export class CreateDeliverySlotRequestDto {
  @ApiProperty({ type: String, pattern: code.source }) @IsString() @Matches(code) code!: string;
  @IsString() @Length(1, 100) name!: string;
  @ApiProperty({ type: String, pattern: localTime.source, example: '06:00' }) @IsString() @Matches(localTime) startLocalTime!: string;
  @ApiProperty({ type: String, pattern: localTime.source, example: '09:00' }) @IsString() @Matches(localTime) endLocalTime!: string;
}
export class RenameDeliverySlotRequestDto { @IsString() @Length(1, 100) name!: string; }
export class UnitResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string;
  code!: string; name!: string; decimalScale!: number;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class UnitListResponseDto {
  @ApiProperty({ type: () => UnitResponseDto, isArray: true }) items!: UnitResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
export class ProductResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string;
  code!: string; name!: string;
  @ApiProperty({ type: String, format: 'uuid' }) defaultUnitId!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: string;
  version!: number;
  @ApiProperty({ enum: recordLifecycles }) lifecycle!: RecordLifecycle;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class ProductListResponseDto {
  @ApiProperty({ type: () => ProductResponseDto, isArray: true }) items!: ProductResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
export class DeliverySlotResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string;
  code!: string; name!: string;
  @ApiProperty({ type: String, pattern: localTime.source, example: '06:00' }) startLocalTime!: string;
  @ApiProperty({ type: String, pattern: localTime.source, example: '09:00' }) endLocalTime!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class DeliverySlotListResponseDto {
  @ApiProperty({ type: () => DeliverySlotResponseDto, isArray: true }) items!: DeliverySlotResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
export const toUnitResponse = (value: UnitRecord): UnitResponseDto => ({ ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() });
export const toProductResponse = (value: ProductResult): ProductResponseDto => ({
  id: value.id,
  vendorId: value.vendorId,
  code: value.code,
  name: value.name,
  defaultUnitId: value.defaultUnitId,
  status: value.status,
  version: value.version,
  lifecycle: value.lifecycle,
  createdAt: value.createdAt.toISOString(),
  updatedAt: value.updatedAt.toISOString(),
});
export const toDeliverySlotResponse = (value: DeliverySlotRecord): DeliverySlotResponseDto => ({ ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() });
