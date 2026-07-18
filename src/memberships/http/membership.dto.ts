import { Type } from 'class-transformer';
import {
  IsIn,
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

import type { VendorRole } from '../../common/context/request-context.js';

const vendorRoles = [
  'vendor_owner',
  'vendor_administrator',
  'delivery_agent',
  'customer',
] as const;

export class ListMembershipsQueryDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ type: Number, default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CreateMembershipRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ type: String, enum: vendorRoles })
  @IsIn(vendorRoles)
  role!: VendorRole;
}

export class UpdateMembershipRoleRequestDto {
  @ApiProperty({ type: String, enum: vendorRoles })
  @IsIn(vendorRoles)
  role!: VendorRole;
}

export class ReasonRequestDto {
  @ApiProperty({ type: String, minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class MembershipResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: String, enum: vendorRoles })
  role!: VendorRole;

  @ApiProperty({ type: String, enum: ['invited', 'active', 'ended'] })
  status!: 'invited' | 'active' | 'ended';

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  joinedAt?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  endedAt?: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class MembershipPageResponseDto {
  @ApiProperty({ type: () => [MembershipResponseDto] })
  items!: MembershipResponseDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class UserResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  displayName!: string;

  @ApiProperty({ type: String, enum: ['active', 'suspended', 'deactivated'] })
  status!: 'active' | 'suspended' | 'deactivated';

  @ApiProperty({ type: String })
  locale!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
