import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { LeaveService } from '../application/leave.service.js';
import { DecideLeaveOccurrenceRequestDto, toDecisionPageResponse, toDecisionResultResponse, toLeaveRequestResponse, VendorLeaveDecisionListResponseDto, VendorLeaveDecisionPageQueryDto, VendorLeaveDecisionResponseEnvelopeDto, VendorLeaveRequestDetailResponseDto } from './leave.dto.js';

@ApiTags('Vendor leave') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@Controller('vendors/:vendorId')
export class VendorLeaveController {
  constructor(@Inject(LeaveService) private readonly leaves: LeaveService) {}
  @Get('leave-occurrence-decisions') @ApiResponse({ status: 200, type: VendorLeaveDecisionListResponseDto }) async listDecisions(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Query() query: VendorLeaveDecisionPageQueryDto) { return toDecisionPageResponse(await this.leaves.listDecisions(requestContextStore.requireActor(), vendorId, query)); }
  @Get('leave-requests/:leaveRequestId') @ApiResponse({ status: 200, type: VendorLeaveRequestDetailResponseDto }) async getRequest(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('leaveRequestId', new ParseUUIDPipe({ version: '4' })) leaveRequestId: string) { return toLeaveRequestResponse(await this.leaves.getVendorRequest(requestContextStore.requireActor(), vendorId, leaveRequestId)); }
  @Post('leave-occurrence-decisions/:decisionId/decision') @HttpCode(200) @ApiResponse({ status: 200, type: VendorLeaveDecisionResponseEnvelopeDto }) async decide(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('decisionId', new ParseUUIDPipe({ version: '4' })) decisionId: string, @Body() body: DecideLeaveOccurrenceRequestDto) { return toDecisionResultResponse(await this.leaves.decideOccurrence(requestContextStore.requireActor(), vendorId, decisionId, body)); }
}
for (const status of [400, 401, 403, 404, 409, 503]) ApiResponse({ status, type: ApiErrorResponseDto })(VendorLeaveController);
for (const [key, types] of [
  ['listDecisions', [String, VendorLeaveDecisionPageQueryDto]], ['getRequest', [String, String]], ['decide', [String, String, DecideLeaveOccurrenceRequestDto]],
] as const) Reflect.defineMetadata('design:paramtypes', types, VendorLeaveController.prototype, key);
