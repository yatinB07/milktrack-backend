import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import type { RouteResult } from '../application/route.store.js';
import type { AgentRouteAssignmentRecord, RouteAssignmentMutation, RouteAssignmentRecord } from '../application/route-assignment.store.js';
import { LifecycleQueryDto } from '../../common/http/record-lifecycle.dto.js';
import { recordLifecycles } from '../../common/application/record-lifecycle.js';

const code = /^[A-Za-z0-9_-]{2,32}$/;
export class RoutePageQueryDto extends LifecycleQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @ApiPropertyOptional({ enum: ['active', 'inactive'] }) @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
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
  @ApiProperty({ enum: recordLifecycles }) lifecycle!: string;
  version!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class RouteListResponseDto { @ApiProperty({ type: () => RouteResponseDto, isArray: true }) items!: RouteResponseDto[]; @ApiPropertyOptional({ type: String }) nextCursor?: string; }
export class RouteStopsQueryDto {
  @ApiProperty({ type: String, format: 'date' }) @IsString() serviceDate!: string;
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class ReplaceRouteStopsRequestDto {
  @ApiProperty({ type: String, format: 'date' }) @IsString() effectiveDate!: string;
  @ApiProperty({ type: Number, minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @ApiProperty({ type: String, minLength: 3, maxLength: 500 }) @IsString() reason!: string;
  @ApiProperty({ type: String, format: 'uuid', isArray: true }) @IsArray() @IsUUID('4', { each: true }) householdIds!: string[];
}
export class RouteStopHouseholdResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) accountNumber!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) addressLine1!: string;
  @ApiPropertyOptional({ type: String }) addressLine2?: string;
  @ApiPropertyOptional({ type: String }) locality?: string;
  @ApiProperty({ type: String }) city!: string;
  @ApiProperty({ type: String }) region!: string;
  @ApiProperty({ type: String }) postalCode!: string;
  @ApiProperty({ type: String, minLength: 2, maxLength: 2 }) countryCode!: string;
  @ApiPropertyOptional({ type: String }) latitude?: string;
  @ApiPropertyOptional({ type: String }) longitude?: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: 'active' | 'inactive';
}
export class RouteStopResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) householdId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) sequence!: number;
  @ApiProperty({ type: () => RouteStopHouseholdResponseDto }) household!: RouteStopHouseholdResponseDto;
}
export class RouteStopsResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) routeId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) routeVersion!: number;
  @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string;
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiPropertyOptional({ type: String, format: 'date' }) startDate?: string;
  @ApiPropertyOptional({ type: String, format: 'date' }) endDate?: string;
  @ApiProperty({ type: () => RouteStopResponseDto, isArray: true }) stops!: RouteStopResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
export class RouteAssignmentPageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @ApiPropertyOptional({ type: String, format: 'date' }) @IsOptional() @IsString() fromDate?: string;
  @ApiPropertyOptional({ type: String, format: 'date' }) @IsOptional() @IsString() toDate?: string;
  @ApiPropertyOptional({ enum: ['assigned','cancelled'] }) @IsOptional() @IsIn(['assigned','cancelled']) status?: 'assigned'|'cancelled';
}
export class AgentRouteAssignmentQueryDto {
  @ApiProperty({ type: String, format: 'date' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) serviceDate!: string;
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class AssignRouteRequestDto {
  @ApiProperty({ type: String, format: 'uuid' }) @IsUUID('4') agentMembershipId!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @ApiProperty({ type: String, minLength: 3, maxLength: 500 }) @IsString() reason!: string;
}
export class RouteAssignmentResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) routeId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) agentMembershipId!: string;
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ enum: ['assigned','cancelled'] }) status!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class RouteAssignmentMutationResponseDto extends RouteAssignmentResponseDto { @ApiProperty({ type: Number, minimum: 1 }) routeVersion!: number; }
export class RouteAssignmentListResponseDto { @ApiProperty({ type:()=>RouteAssignmentResponseDto,isArray:true }) items!:RouteAssignmentResponseDto[]; @ApiPropertyOptional({type:String}) nextCursor?:string; }
export class AgentRouteAssignmentResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) routeId!: string;
  routeCode!: string;
  routeName!: string;
  @ApiProperty({ type: String, format: 'uuid' }) deliverySlotId!: string;
  deliverySlotName!: string;
  deliverySlotStartLocalTime!: string;
  deliverySlotEndLocalTime!: string;
  @ApiProperty({ type: String, format: 'uuid' }) agentMembershipId!: string;
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ enum: ['assigned', 'cancelled'] }) status!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class AgentRouteAssignmentListResponseDto {
  @ApiProperty({ type: String, format: 'date' }) serviceDate!: string;
  @ApiProperty({ type: () => AgentRouteAssignmentResponseDto, isArray: true }) items!: AgentRouteAssignmentResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
export const toRouteAssignmentResponse=(value:RouteAssignmentRecord):RouteAssignmentResponseDto=>({id:value.id,routeId:value.routeId,deliverySlotId:value.deliverySlotId,agentMembershipId:value.agentMembershipId,serviceDate:value.serviceDate,status:value.status,createdAt:value.createdAt.toISOString(),updatedAt:value.updatedAt.toISOString()});
export const toAgentRouteAssignmentResponse=(value:RouteAssignmentRecord):AgentRouteAssignmentResponseDto=>{
  assertAgentRouteAssignment(value);
  return {id:value.id,routeId:value.routeId,routeCode:value.routeCode,routeName:value.routeName,deliverySlotId:value.deliverySlotId,deliverySlotName:value.deliverySlotName,deliverySlotStartLocalTime:value.deliverySlotStartLocalTime,deliverySlotEndLocalTime:value.deliverySlotEndLocalTime,agentMembershipId:value.agentMembershipId,serviceDate:value.serviceDate,status:value.status,createdAt:value.createdAt.toISOString(),updatedAt:value.updatedAt.toISOString()};
};
export const toRouteAssignmentMutationResponse=(value:RouteAssignmentMutation):RouteAssignmentMutationResponseDto=>({...toRouteAssignmentResponse(value.assignment),routeVersion:value.routeVersion});
export const toRouteResponse = ({ lifecycle, ...route }: RouteResult): RouteResponseDto => ({ ...route, lifecycle, createdAt: route.createdAt.toISOString(), updatedAt: route.updatedAt.toISOString() });

function assertAgentRouteAssignment(value: RouteAssignmentRecord): asserts value is AgentRouteAssignmentRecord {
  for (const key of ['routeCode', 'routeName', 'deliverySlotName', 'deliverySlotStartLocalTime', 'deliverySlotEndLocalTime'] as const) {
    if (typeof (value as Record<string, unknown>)[key] !== 'string') throw new TypeError(`Agent route assignment is missing ${key}`);
  }
}
