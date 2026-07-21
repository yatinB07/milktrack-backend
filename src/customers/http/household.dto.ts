import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  type RecordLifecycle,
  recordLifecycles,
} from "../../common/application/record-lifecycle.js";
import type {
  HouseholdMemberResult,
  HouseholdResult,
} from "../application/household.service.js";

const decimal = /^-?\d{1,3}(\.\d{1,6})?$/;
export class HouseholdPageQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ type: Number, default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
export class HouseholdDiscoveryQueryDto extends HouseholdPageQueryDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 160 })
  @IsOptional()
  @IsString()
  @Length(1, 160)
  @Matches(/\S/)
  search?: string;

  @ApiPropertyOptional({ enum: ["active", "inactive"], default: "active" })
  @IsOptional()
  @IsIn(["active", "inactive"])
  status?: "active" | "inactive";

  @ApiPropertyOptional({ enum: recordLifecycles, default: "current" })
  @IsOptional()
  @IsIn(recordLifecycles)
  lifecycle?: RecordLifecycle;
}
export class CreateHouseholdRequestDto {
  @IsString() @Length(1, 80) accountNumber!: string;
  @IsString() @Length(1, 160) name!: string;
  @IsString() @Length(1, 240) addressLine1!: string;
  @IsOptional() @IsString() @Length(1, 240) addressLine2?: string;
  @IsOptional() @IsString() @Length(1, 120) locality?: string;
  @IsString() @Length(1, 120) city!: string;
  @IsString() @Length(1, 120) region!: string;
  @IsString() @Length(1, 40) postalCode!: string;
  @IsString() @Matches(/^[A-Za-z]{2}$/) countryCode!: string;
  @IsOptional() @IsString() @Matches(decimal) latitude?: string;
  @IsOptional() @IsString() @Matches(decimal) longitude?: string;
  @IsOptional() @IsString() @Length(1, 1000) notes?: string;
}
export class UpdateHouseholdRequestDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsString() @Length(1, 80) accountNumber?: string;
  @IsOptional() @IsString() @Length(1, 160) name?: string;
  @IsOptional() @IsString() @Length(1, 240) addressLine1?: string;
  @IsOptional() @IsString() @Length(1, 240) addressLine2?: string | null;
  @IsOptional() @IsString() @Length(1, 120) locality?: string | null;
  @IsOptional() @IsString() @Length(1, 120) city?: string;
  @IsOptional() @IsString() @Length(1, 120) region?: string;
  @IsOptional() @IsString() @Length(1, 40) postalCode?: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2}$/) countryCode?: string;
  @IsOptional() @IsString() @Matches(decimal) latitude?: string | null;
  @IsOptional() @IsString() @Matches(decimal) longitude?: string | null;
  @IsOptional() @IsIn(["active", "inactive"]) status?: "active" | "inactive";
  @IsOptional() @IsString() @Length(1, 1000) notes?: string | null;
}
export class VersionedReasonRequestDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsString() @Length(3, 500) reason!: string;
}
export class AttachHouseholdMemberRequestDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsString() @Matches(/^[0-9a-f-]{36}$/i) customerMembershipId!: string;
}
export class EndHouseholdMemberRequestDto {
  @IsString() @Length(3, 500) reason!: string;
}
export class HouseholdResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) vendorId!: string;
  accountNumber!: string;
  name!: string;
  addressLine1!: string;
  addressLine2?: string;
  locality?: string;
  city!: string;
  region!: string;
  postalCode!: string;
  countryCode!: string;
  latitude?: string;
  longitude?: string;
  @ApiProperty({ enum: ["active", "inactive"] }) status!: string;
  notes?: string;
  version!: number;
  @ApiProperty({ enum: recordLifecycles }) lifecycle!: RecordLifecycle;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}
export class HouseholdListResponseDto {
  @ApiProperty({ type: () => HouseholdResponseDto, isArray: true })
  items!: HouseholdResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
export class CustomerHouseholdResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) vendorId!: string;
  accountNumber!: string;
  name!: string;
  addressLine1!: string;
  addressLine2?: string;
  locality?: string;
  city!: string;
  region!: string;
  postalCode!: string;
  countryCode!: string;
  latitude?: string;
  longitude?: string;
  @ApiProperty({ enum: ["active", "inactive"] }) status!: string;
  version!: number;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}
export class CustomerHouseholdListResponseDto {
  @ApiProperty({ type: () => CustomerHouseholdResponseDto, isArray: true })
  items!: CustomerHouseholdResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
export class HouseholdMemberResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) householdId!: string;
  @ApiProperty({ type: String, format: "uuid" })
  customerMembershipId!: string;
  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  displayName?: string;
  phone?: string;
  @ApiProperty({ enum: ["active", "ended"] }) status!: string;
  @ApiProperty({ type: String, format: "date-time" }) joinedAt!: string;
  @ApiPropertyOptional({ type: String, format: "date-time" }) endedAt?: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}
export class HouseholdMemberListResponseDto {
  @ApiProperty({ type: () => HouseholdMemberResponseDto, isArray: true })
  items!: HouseholdMemberResponseDto[];
  @ApiPropertyOptional({ type: String }) nextCursor?: string;
}
export const toHouseholdResponse = (
  value: HouseholdResult,
): HouseholdResponseDto => ({
  id: value.id,
  vendorId: value.vendorId,
  accountNumber: value.accountNumber,
  name: value.name,
  addressLine1: value.addressLine1,
  ...(value.addressLine2 ? { addressLine2: value.addressLine2 } : {}),
  ...(value.locality ? { locality: value.locality } : {}),
  city: value.city,
  region: value.region,
  postalCode: value.postalCode,
  countryCode: value.countryCode,
  ...(value.latitude ? { latitude: value.latitude } : {}),
  ...(value.longitude ? { longitude: value.longitude } : {}),
  status: value.status,
  ...(value.notes ? { notes: value.notes } : {}),
  version: value.version,
  lifecycle: value.lifecycle,
  createdAt: value.createdAt.toISOString(),
  updatedAt: value.updatedAt.toISOString(),
});
export const toCustomerHouseholdResponse = (
  value: HouseholdResult,
): CustomerHouseholdResponseDto => ({
  id: value.id,
  vendorId: value.vendorId,
  accountNumber: value.accountNumber,
  name: value.name,
  addressLine1: value.addressLine1,
  ...(value.addressLine2 ? { addressLine2: value.addressLine2 } : {}),
  ...(value.locality ? { locality: value.locality } : {}),
  city: value.city,
  region: value.region,
  postalCode: value.postalCode,
  countryCode: value.countryCode,
  ...(value.latitude ? { latitude: value.latitude } : {}),
  ...(value.longitude ? { longitude: value.longitude } : {}),
  status: value.status,
  version: value.version,
  createdAt: value.createdAt.toISOString(),
  updatedAt: value.updatedAt.toISOString(),
});
export const toHouseholdMemberResponse = (
  value: HouseholdMemberResult,
): HouseholdMemberResponseDto => {
  const { endedAt, ...rest } = value;
  return {
    ...rest,
    joinedAt: value.joinedAt.toISOString(),
    ...(endedAt ? { endedAt: endedAt.toISOString() } : {}),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
};
