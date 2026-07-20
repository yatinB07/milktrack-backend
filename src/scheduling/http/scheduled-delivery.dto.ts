import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class AgentScheduledDeliveryQueryDto {
  @ApiProperty({ type: String, format: 'date' }) @IsString() serviceDate!: string;
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
}

export class ScheduledDeliveryListResponseDto {
  @ApiProperty({ type: () => ScheduledDeliveryResponseDto, isArray: true })
  items!: ScheduledDeliveryResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
