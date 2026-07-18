import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { PlatformRole, VendorRole } from '../../common/context/request-context.js';

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const OTP_PATTERN = /^\d{6}$/;

export type ClientType = 'browser' | 'mobile';

export class RequestOtpRequestDto {
  @ApiProperty({ type: String, example: '+919876543210', pattern: E164_PATTERN.source })
  @Matches(E164_PATTERN)
  phone!: string;

  @ApiProperty({ type: String, enum: ['sign_in'] })
  @IsIn(['sign_in'])
  purpose!: 'sign_in';
}

export class VerifyOtpRequestDto {
  @ApiProperty({ type: String, minLength: 43, maxLength: 43 })
  @Matches(OPAQUE_TOKEN_PATTERN)
  challengeToken!: string;

  @ApiProperty({ type: String, pattern: OTP_PATTERN.source })
  @Matches(OTP_PATTERN)
  code!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 128, pattern: DEVICE_ID_PATTERN.source })
  @Matches(DEVICE_ID_PATTERN)
  deviceId!: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  deviceName?: string;

  @ApiProperty({ type: String, enum: ['browser', 'mobile'] })
  @IsIn(['browser', 'mobile'])
  clientType!: ClientType;
}

export class AdminPasswordRequestDto {
  @ApiProperty({ type: String, format: 'email', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 1024, writeOnly: true })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 128, pattern: DEVICE_ID_PATTERN.source })
  @Matches(DEVICE_ID_PATTERN)
  deviceId!: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  deviceName?: string;
}

export class AdminMfaRequestDto {
  @ApiProperty({ type: String, minLength: 43, maxLength: 43 })
  @Matches(OPAQUE_TOKEN_PATTERN)
  pendingMfaToken!: string;

  @ApiProperty({ type: String, pattern: OTP_PATTERN.source, writeOnly: true })
  @Matches(OTP_PATTERN)
  code!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 128, pattern: DEVICE_ID_PATTERN.source })
  @Matches(DEVICE_ID_PATTERN)
  deviceId!: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  deviceName?: string;

  @ApiProperty({ type: String, enum: ['browser', 'mobile'] })
  @IsIn(['browser', 'mobile'])
  clientType!: ClientType;
}

export class RefreshRequestDto {
  @ApiPropertyOptional({ type: String, minLength: 43, maxLength: 43, writeOnly: true })
  @IsOptional()
  @Matches(OPAQUE_TOKEN_PATTERN)
  refreshToken?: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 128, pattern: DEVICE_ID_PATTERN.source })
  @Matches(DEVICE_ID_PATTERN)
  deviceId!: string;

  @ApiProperty({ type: String, enum: ['browser', 'mobile'] })
  @IsIn(['browser', 'mobile'])
  clientType!: ClientType;
}

export class OtpChallengeResponseDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  accepted!: true;

  @ApiProperty({ type: String, minLength: 43, maxLength: 43 })
  challengeToken!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;
}

export class PendingMfaResponseDto {
  @ApiProperty({ type: String, minLength: 43, maxLength: 43 })
  pendingMfaToken!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;
}

export class SessionResponseDto {
  @ApiProperty({ type: String })
  accessToken!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  accessExpiresAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  refreshExpiresAt!: string;

  @ApiPropertyOptional({ type: String })
  refreshToken?: string;
}

export class MembershipSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ type: String })
  vendorName!: string;

  @ApiProperty({
    type: String,
    enum: ['vendor_owner', 'vendor_administrator', 'delivery_agent', 'customer'],
  })
  role!: VendorRole;

  @ApiProperty({ type: String, enum: ['invited', 'active', 'ended'] })
  status!: string;
}

export class CurrentActorResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: String })
  displayName!: string;

  @ApiProperty({
    type: String,
    enum: ['product_owner', 'platform_administrator', 'support_operations'],
    isArray: true,
  })
  platformRoles!: PlatformRole[];

  @ApiProperty({ type: MembershipSummaryDto, isArray: true })
  memberships!: MembershipSummaryDto[];

  @ApiProperty({ type: String, format: 'uuid' })
  sessionId!: string;
}
