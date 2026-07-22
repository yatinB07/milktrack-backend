import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { NotificationRecord } from '../infrastructure/prisma-notification.store.js';
import { notificationTypes } from '../application/notification-writer.js';

export class CustomerNotificationPageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class CustomerNotificationResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: notificationTypes }) type!: typeof notificationTypes[number];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) payload!: Record<string, string>;
  @ApiPropertyOptional({ format: 'date-time' }) readAt?: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class CustomerNotificationListResponseDto {
  @ApiProperty({ type: () => CustomerNotificationResponseDto, isArray: true }) items!: CustomerNotificationResponseDto[];
  @ApiPropertyOptional() nextCursor?: string;
}
export function toCustomerNotificationResponse(value: NotificationRecord): CustomerNotificationResponseDto {
  return { id: value.id, type: value.type, payload: { ...value.payload }, ...(value.readAt ? { readAt: value.readAt.toISOString() } : {}), createdAt: value.createdAt.toISOString() };
}
