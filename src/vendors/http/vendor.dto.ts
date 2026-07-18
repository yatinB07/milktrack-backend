import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { VendorStatus } from '../domain/vendor-lifecycle.js';
import type { VendorResult } from '../application/vendor.service.js';

export const VENDOR_STATUSES = [
  'pending_approval',
  'onboarding',
  'trial',
  'active',
  'suspended',
  'closed',
] as const satisfies readonly VendorStatus[];

export class CreateVendorRequestDto {
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,32}$/)
  code!: string;

  @IsString()
  @Length(2, 120)
  legalName!: string;

  @IsString()
  @Length(2, 120)
  displayName!: string;

  @IsString()
  @Length(1, 100)
  timezone!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  skipCutoffMinutes!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  billingDay!: number;
}

export class ListVendorsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @ApiPropertyOptional({ type: Number, default: 25, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: VENDOR_STATUSES })
  @IsOptional()
  @IsIn(VENDOR_STATUSES)
  status?: VendorStatus;
}

export class TransitionVendorRequestDto {
  @ApiProperty({ enum: VENDOR_STATUSES })
  @IsIn(VENDOR_STATUSES)
  to!: VendorStatus;

  @IsString()
  @Length(3, 500)
  reason!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class VendorResponseDto {
  id!: string;
  code!: string;
  legalName!: string;
  displayName!: string;

  @ApiProperty({ enum: VENDOR_STATUSES })
  status!: VendorStatus;

  timezone!: string;
  currency!: string;
  skipCutoffMinutes!: number;
  billingDay!: number;
  version!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class VendorListResponseDto {
  @ApiProperty({ type: () => VendorResponseDto, isArray: true })
  items!: VendorResponseDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export function toVendorResponse(vendor: VendorResult): VendorResponseDto {
  return {
    id: vendor.id,
    code: vendor.code,
    legalName: vendor.legalName,
    displayName: vendor.displayName,
    status: vendor.status,
    timezone: vendor.timezone,
    currency: vendor.currency,
    skipCutoffMinutes: vendor.skipCutoffMinutes,
    billingDay: vendor.billingDay,
    version: vendor.version,
    createdAt: vendor.createdAt.toISOString(),
    updatedAt: vendor.updatedAt.toISOString(),
  };
}
