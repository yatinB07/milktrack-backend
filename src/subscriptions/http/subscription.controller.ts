import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { SubscriptionService } from '../application/subscription.service.js';
import {
  CreateSubscriptionRequestDto, CustomerSubscriptionHistoryResponseDto, CustomerSubscriptionListResponseDto, CustomerSubscriptionPageQueryDto,
  CustomerSubscriptionResponseDto, ModifySubscriptionRequestDto, SubscriptionHistoryQueryDto, SubscriptionHistoryResponseDto,
  SubscriptionListResponseDto, SubscriptionPageQueryDto, SubscriptionResponseDto, SubscriptionTransitionRequestDto,
  SubscriptionVersionReasonRequestDto, toCustomerSubscriptionResponse, toCustomerSubscriptionRevisionResponse,
  toSubscriptionResponse, toSubscriptionRevisionResponse,
} from './subscription.dto.js';

const errors = [400, 401, 403, 404, 409, 503];

@ApiTags('Subscriptions') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@Controller('vendors/:vendorId/subscriptions')
export class VendorSubscriptionController {
  constructor(@Inject(SubscriptionService) private readonly subscriptions: SubscriptionService) {}
  @Get() @ApiResponse({ status: 200, type: SubscriptionListResponseDto }) async list(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Query() query: SubscriptionPageQueryDto) {
    const page = await this.subscriptions.list(requestContextStore.requireActor(), vendorId, query);
    return { items: page.items.map(toSubscriptionResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  @Post() @ApiResponse({ status: 201, type: SubscriptionResponseDto }) async create(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Body() body: CreateSubscriptionRequestDto) {
    return toSubscriptionResponse(await this.subscriptions.create(requestContextStore.requireActor(), vendorId, body));
  }
  @Get(':subscriptionId') @ApiResponse({ status: 200, type: SubscriptionResponseDto }) async get(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string) {
    return toSubscriptionResponse(await this.subscriptions.get(requestContextStore.requireActor(), vendorId, subscriptionId));
  }
  @Get(':subscriptionId/revisions') @ApiResponse({ status: 200, type: SubscriptionHistoryResponseDto }) async history(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Query() query: SubscriptionHistoryQueryDto) {
    const page = await this.subscriptions.history(requestContextStore.requireActor(), vendorId, subscriptionId, query);
    return { items: page.items.map(toSubscriptionRevisionResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  @Post(':subscriptionId/modify') @HttpCode(200) @ApiResponse({ status: 200, type: SubscriptionResponseDto }) modify(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Body() body: ModifySubscriptionRequestDto) { return this.change('modify', vendorId, subscriptionId, body); }
  @Post(':subscriptionId/pause') @HttpCode(200) @ApiResponse({ status: 200, type: SubscriptionResponseDto }) pause(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Body() body: SubscriptionTransitionRequestDto) { return this.change('pause', vendorId, subscriptionId, body); }
  @Post(':subscriptionId/resume') @HttpCode(200) @ApiResponse({ status: 200, type: SubscriptionResponseDto }) resume(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Body() body: SubscriptionTransitionRequestDto) { return this.change('resume', vendorId, subscriptionId, body); }
  @Post(':subscriptionId/cancel') @HttpCode(200) @ApiResponse({ status: 200, type: SubscriptionResponseDto }) cancel(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Body() body: SubscriptionTransitionRequestDto) { return this.change('cancel', vendorId, subscriptionId, body); }
  @Delete(':subscriptionId') @HttpCode(204) async softDelete(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Body() body: SubscriptionVersionReasonRequestDto) { await this.subscriptions.softDelete(requestContextStore.requireActor(), vendorId, subscriptionId, body); }
  @Post(':subscriptionId/restore') @HttpCode(200) @ApiResponse({ status: 200, type: SubscriptionResponseDto }) async restore(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Body() body: SubscriptionVersionReasonRequestDto) { return toSubscriptionResponse(await this.subscriptions.restore(requestContextStore.requireActor(), vendorId, subscriptionId, body)); }
  private async change(operation: 'modify' | 'pause' | 'resume' | 'cancel', vendorId: string, subscriptionId: string, body: ModifySubscriptionRequestDto | SubscriptionTransitionRequestDto) {
    const result = operation === 'modify'
      ? await this.subscriptions.modify(requestContextStore.requireActor(), vendorId, subscriptionId, body as ModifySubscriptionRequestDto)
      : await this.subscriptions[operation](requestContextStore.requireActor(), vendorId, subscriptionId, body);
    return toSubscriptionResponse(result);
  }
}

@ApiTags('Customer subscriptions') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@Controller('customer/vendors/:vendorId/households/:householdId/subscriptions')
export class CustomerSubscriptionController {
  constructor(@Inject(SubscriptionService) private readonly subscriptions: SubscriptionService) {}
  @Get() @ApiResponse({ status: 200, type: CustomerSubscriptionListResponseDto }) async list(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('householdId', ParseUUIDPipe) householdId: string, @Query() query: CustomerSubscriptionPageQueryDto) {
    const page = await this.subscriptions.listCustomer(requestContextStore.requireActor(), vendorId, householdId, query);
    return { items: page.items.map(toCustomerSubscriptionResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  @Get(':subscriptionId') @ApiResponse({ status: 200, type: CustomerSubscriptionResponseDto }) async get(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('householdId', ParseUUIDPipe) householdId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string) {
    return toCustomerSubscriptionResponse(await this.subscriptions.getCustomer(requestContextStore.requireActor(), vendorId, householdId, subscriptionId));
  }
  @Get(':subscriptionId/revisions') @ApiResponse({ status: 200, type: CustomerSubscriptionHistoryResponseDto }) async history(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('householdId', ParseUUIDPipe) householdId: string, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Query() query: SubscriptionHistoryQueryDto) {
    const page = await this.subscriptions.historyCustomer(requestContextStore.requireActor(), vendorId, householdId, subscriptionId, query);
    return { items: page.items.map(toCustomerSubscriptionRevisionResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
}

for (const controller of [VendorSubscriptionController, CustomerSubscriptionController])
  for (const status of errors) ApiResponse({ status, type: ApiErrorResponseDto })(controller);

for (const [key, types] of [
  ['list', [String, SubscriptionPageQueryDto]], ['create', [String, CreateSubscriptionRequestDto]], ['get', [String, String]],
  ['history', [String, String, SubscriptionHistoryQueryDto]], ['modify', [String, String, ModifySubscriptionRequestDto]],
  ['pause', [String, String, SubscriptionTransitionRequestDto]], ['resume', [String, String, SubscriptionTransitionRequestDto]],
  ['cancel', [String, String, SubscriptionTransitionRequestDto]], ['softDelete', [String, String, SubscriptionVersionReasonRequestDto]],
  ['restore', [String, String, SubscriptionVersionReasonRequestDto]],
] as const) Reflect.defineMetadata('design:paramtypes', types, VendorSubscriptionController.prototype, key);
for (const [key, types] of [['list', [String, String, CustomerSubscriptionPageQueryDto]], ['get', [String, String, String]], ['history', [String, String, String, SubscriptionHistoryQueryDto]]] as const)
  Reflect.defineMetadata('design:paramtypes', types, CustomerSubscriptionController.prototype, key);
