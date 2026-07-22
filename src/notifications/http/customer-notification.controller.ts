import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { NotificationService } from '../application/notification.service.js';
import { CustomerNotificationListResponseDto, CustomerNotificationPageQueryDto, toCustomerNotificationResponse } from './notification.dto.js';

@ApiTags('Customer notifications') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@ApiResponse({ status: 400, type: ApiErrorResponseDto }) @ApiResponse({ status: 401, type: ApiErrorResponseDto }) @ApiResponse({ status: 403, type: ApiErrorResponseDto }) @ApiResponse({ status: 404, type: ApiErrorResponseDto }) @ApiResponse({ status: 503, type: ApiErrorResponseDto })
@Controller('customer/vendors/:vendorId/households/:householdId/notifications')
export class CustomerNotificationController {
  constructor(@Inject(NotificationService) private readonly notifications: NotificationService) {}
  @Get() @ApiResponse({ status: 200, type: CustomerNotificationListResponseDto }) async list(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('householdId', ParseUUIDPipe) householdId: string, @Query() query: CustomerNotificationPageQueryDto) {
    const page = await this.notifications.listCustomer(requestContextStore.requireActor(), vendorId, householdId, query);
    return { items: page.items.map(toCustomerNotificationResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
}
Reflect.defineMetadata('design:paramtypes', [String, String, CustomerNotificationPageQueryDto], CustomerNotificationController.prototype, 'list');
