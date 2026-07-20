import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import type { RouteRecord } from '../application/route.store.js';

const code = /^[A-Za-z0-9_-]{2,32}$/;
export class RoutePageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @ApiPropertyOptional({ enum: ['active', 'inactive'], default: 'active' }) @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
  @ApiPropertyOptional({ type: String, format: 'uuid' }) @IsOptional() @IsUUID() deliverySlotId?: string;
  @IsOptional() @IsString() @Length(1, 100) search?: string;
}
export class CreateRouteRequestDto {
  @ApiProperty({ type: String, pattern: code.source }) @IsString() code!: string;
  @ApiProperty({ type: String, minLength: 1, maxLength: 100 }) @IsString() name!: string;
  @ApiProperty({ type: String, format: 'uuid' }) @IsUUID() deliverySlotId!: string;
}
export class RenameRouteRequestDto { @ApiProperty({ type: String, minLength: 1, maxLength: 100 }) @IsString() name!: string; @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number; }
export class RouteVersionReasonRequestDto { @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number; @ApiProperty({ type: String, minLength: 3, maxLength: 500 }) @IsString() reason!: string; }
export class RouteResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string;
  code!: string; name!: string;
  @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: string;
  version!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class RouteListResponseDto { @ApiProperty({ type: () => RouteResponseDto, isArray: true }) items!: RouteResponseDto[]; @ApiPropertyOptional({ type: String }) nextCursor?: string; }
export const toRouteResponse = (route: RouteRecord): RouteResponseDto => ({ ...route, createdAt: route.createdAt.toISOString(), updatedAt: route.updatedAt.toISOString() });
