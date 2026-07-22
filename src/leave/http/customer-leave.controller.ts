import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { LeaveService } from '../application/leave.service.js';
import { AmendCustomerLeaveRequestDto, CancelCustomerLeaveRequestDto, CreateCustomerLeaveRequestDto, CustomerLeaveDetailResponseDto, CustomerLeaveListResponseDto, CustomerLeavePageQueryDto, CustomerLeavePreviewRequestDto, CustomerLeavePreviewResponseDto, toCustomerLeaveRequestResponse, toLeavePageResponse, toLeavePreviewResponse } from './leave.dto.js';

@ApiTags('Customer leave') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@Controller('customer/vendors/:vendorId/households/:householdId/leave-requests')
export class CustomerLeaveController {
  constructor(@Inject(LeaveService) private readonly leaves: LeaveService) {}
  @Post('preview') @HttpCode(200) @ApiResponse({ status: 200, type: CustomerLeavePreviewResponseDto }) async preview(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('householdId', new ParseUUIDPipe({ version: '4' })) householdId: string, @Body() body: CustomerLeavePreviewRequestDto) { return toLeavePreviewResponse(await this.leaves.preview(requestContextStore.requireActor(), vendorId, householdId, body)); }
  @Get() @ApiResponse({ status: 200, type: CustomerLeaveListResponseDto }) async list(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('householdId', new ParseUUIDPipe({ version: '4' })) householdId: string, @Query() query: CustomerLeavePageQueryDto) { return toLeavePageResponse(await this.leaves.listCustomer(requestContextStore.requireActor(), vendorId, householdId, query)); }
  @Post() @ApiResponse({ status: 201, type: CustomerLeaveDetailResponseDto }) async create(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('householdId', new ParseUUIDPipe({ version: '4' })) householdId: string, @Body() body: CreateCustomerLeaveRequestDto) { return toCustomerLeaveRequestResponse(await this.leaves.create(requestContextStore.requireActor(), vendorId, householdId, body)); }
  @Get(':leaveRequestId') @ApiResponse({ status: 200, type: CustomerLeaveDetailResponseDto }) async get(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('householdId', new ParseUUIDPipe({ version: '4' })) householdId: string, @Param('leaveRequestId', new ParseUUIDPipe({ version: '4' })) leaveRequestId: string) { return toCustomerLeaveRequestResponse(await this.leaves.getCustomer(requestContextStore.requireActor(), vendorId, householdId, leaveRequestId)); }
  @Post(':leaveRequestId/amendments') @HttpCode(200) @ApiResponse({ status: 200, type: CustomerLeaveDetailResponseDto }) async amend(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('householdId', new ParseUUIDPipe({ version: '4' })) householdId: string, @Param('leaveRequestId', new ParseUUIDPipe({ version: '4' })) leaveRequestId: string, @Body() body: AmendCustomerLeaveRequestDto) { return toCustomerLeaveRequestResponse(await this.leaves.amend(requestContextStore.requireActor(), vendorId, householdId, leaveRequestId, body)); }
  @Post(':leaveRequestId/cancellations') @HttpCode(200) @ApiResponse({ status: 200, type: CustomerLeaveDetailResponseDto }) async cancel(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('householdId', new ParseUUIDPipe({ version: '4' })) householdId: string, @Param('leaveRequestId', new ParseUUIDPipe({ version: '4' })) leaveRequestId: string, @Body() body: CancelCustomerLeaveRequestDto) { return toCustomerLeaveRequestResponse(await this.leaves.cancel(requestContextStore.requireActor(), vendorId, householdId, leaveRequestId, body)); }
}
for (const status of [400, 401, 403, 404, 409, 503]) ApiResponse({ status, type: ApiErrorResponseDto })(CustomerLeaveController);
for (const [key, types] of [
  ['preview', [String, String, CustomerLeavePreviewRequestDto]], ['list', [String, String, CustomerLeavePageQueryDto]],
  ['create', [String, String, CreateCustomerLeaveRequestDto]], ['get', [String, String, String]],
  ['amend', [String, String, String, AmendCustomerLeaveRequestDto]], ['cancel', [String, String, String, CancelCustomerLeaveRequestDto]],
] as const) Reflect.defineMetadata('design:paramtypes', types, CustomerLeaveController.prototype, key);
