import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import type { DeliveryPolicy, LateLeavePolicy } from '../domain/delivery-policy.js';
import { LATE_LEAVE_POLICIES } from '../domain/delivery-policy.js';

export class UpdateDeliveryPolicyRequestDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(10080) skipCutoffMinutes!: number;
  @ApiProperty({ enum: LATE_LEAVE_POLICIES }) @IsIn(LATE_LEAVE_POLICIES) lateLeavePolicy!: LateLeavePolicy;
  @IsBoolean() captureAgentLocationEvidence!: boolean;
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(3, 500) reason!: string;
}

export class DeliveryPolicyResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) vendorId!: string;
  skipCutoffMinutes!: number;
  @ApiProperty({ enum: LATE_LEAVE_POLICIES }) lateLeavePolicy!: LateLeavePolicy;
  captureAgentLocationEvidence!: boolean;
  version!: number;
}

export const toDeliveryPolicyResponse = (value: DeliveryPolicy): DeliveryPolicyResponseDto => ({
  vendorId: value.vendorId,
  skipCutoffMinutes: value.skipCutoffMinutes,
  lateLeavePolicy: value.lateLeavePolicy,
  captureAgentLocationEvidence: value.captureAgentLocationEvidence,
  version: value.version,
});
