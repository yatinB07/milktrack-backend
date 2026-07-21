import { Type } from 'class-transformer';
import {
  IsIn,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
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
const onboardingRoles = ['customer', 'delivery_agent'] as const;
const e164Pattern = /^\+[1-9]\d{7,14}$/;

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

  @ApiPropertyOptional({ type: String, enum: vendorRoles })
  @IsOptional()
  @IsIn(vendorRoles)
  role?: VendorRole;

  @ApiPropertyOptional({ type: String, enum: ['invited', 'active', 'ended'], default: 'active' })
  @IsOptional()
  @IsIn(['invited', 'active', 'ended'])
  status?: 'invited' | 'active' | 'ended';

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 120,
    description:
      'Searches at most 100 membership candidates per request; a sparse or empty result page can include nextCursor.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  search?: string;
}

export class CreateMembershipRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ type: String, enum: vendorRoles })
  @IsIn(vendorRoles)
  role!: VendorRole;
}

export class OnboardMembershipRequestDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName!: string;

  @ApiProperty({ type: String, pattern: e164Pattern.source, example: '+919876543210' })
  @IsString()
  @Matches(e164Pattern)
  phone!: string;

  @ApiProperty({ type: String, enum: onboardingRoles })
  @IsIn(onboardingRoles)
  role!: 'customer' | 'delivery_agent';
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

export class MembershipDirectoryResponseDto extends MembershipResponseDto {
  @ApiProperty({ type: String })
  displayName!: string;

  @ApiPropertyOptional({ type: String })
  phone?: string;

  @ApiPropertyOptional({ type: String, format: 'email' })
  email?: string;
}

export class MembershipPageResponseDto {
  @ApiProperty({ type: () => [MembershipDirectoryResponseDto] })
  items!: MembershipDirectoryResponseDto[];

  @ApiPropertyOptional({
    type: String,
    description: 'Continue when present, including after a sparse or empty search result page.',
  })
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

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  deactivatedAt?: Date;
}

export class EstablishVendorOwnerRequestDto {
  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ type: String, minLength: 2, maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName!: string;

  @ApiProperty({ type: String, minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class VendorOwnerOnboardingResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  membershipId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  enrollmentId!: string;

  @ApiProperty({ type: String, format: 'email' })
  email!: string;

  @ApiProperty({ type: Boolean })
  createdUser!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ type: String, enum: ['delivered'] })
  deliveryStatus!: 'delivered';
}

export class VendorOwnerOnboardingStatusResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  vendorId!: string;

  @ApiProperty({
    type: String,
    enum: [
      'not_started',
      'invited',
      'setup_started',
      'completed',
      'expired',
      'retired',
      'delivery_failed',
    ],
  })
  state!:
    | 'not_started'
    | 'invited'
    | 'setup_started'
    | 'completed'
    | 'expired'
    | 'retired'
    | 'delivery_failed';

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  enrollmentId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  membershipId?: string;

  @ApiPropertyOptional({ type: String })
  ownerDisplayName?: string;

  @ApiPropertyOptional({ type: String, format: 'email' })
  ownerEmail?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  expiresAt?: string;
}

export class RetryOwnerEnrollmentResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  enrollmentId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  membershipId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ type: String, enum: ['delivered'] })
  deliveryStatus!: 'delivered';
}

export class StartOwnerEnrollmentRequestDto {
  @ApiProperty({ type: String, minLength: 20, writeOnly: true })
  @IsString()
  @MinLength(20)
  setupToken!: string;

  @ApiProperty({ type: String, minLength: 12, maxLength: 128, writeOnly: true })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}

export class StartOwnerEnrollmentResponseDto {
  @ApiProperty({ type: String })
  completionToken!: string;

  @ApiProperty({ type: String })
  totpSecret!: string;
}

export class CompleteOwnerEnrollmentRequestDto {
  @ApiProperty({ type: String, minLength: 20, writeOnly: true })
  @IsString()
  @MinLength(20)
  completionToken!: string;

  @ApiProperty({ type: String, pattern: '^\\d{6}$', writeOnly: true })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class CompleteOwnerEnrollmentResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  membershipId!: string;
}
