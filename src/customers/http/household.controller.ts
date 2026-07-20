import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiResponse, ApiTags } from "@nestjs/swagger";
import { requestContextStore } from "../../common/context/request-context.js";
import { ApiErrorResponseDto } from "../../common/errors/application-error.filter.js";
import { ActorGuard } from "../../identity/http/actor.guard.js";
import { HouseholdService } from "../application/household.service.js";
import {
  AttachHouseholdMemberRequestDto,
  CreateHouseholdRequestDto,
  CustomerHouseholdListResponseDto,
  EndHouseholdMemberRequestDto,
  HouseholdListResponseDto,
  HouseholdMemberListResponseDto,
  HouseholdMemberResponseDto,
  HouseholdPageQueryDto,
  HouseholdResponseDto,
  toCustomerHouseholdResponse,
  toHouseholdMemberResponse,
  toHouseholdResponse,
  UpdateHouseholdRequestDto,
  VersionedReasonRequestDto,
} from "./household.dto.js";

@ApiTags("Vendor households")
@ApiBearerAuth("opaqueBearer")
@ApiResponse({ status: 400, type: ApiErrorResponseDto })
@ApiResponse({ status: 401, type: ApiErrorResponseDto })
@ApiResponse({ status: 403, type: ApiErrorResponseDto })
@ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto })
@ApiResponse({ status: 503, type: ApiErrorResponseDto })
@UseGuards(ActorGuard)
@Controller("vendors/:vendorId/households")
export class HouseholdController {
  constructor(
    @Inject(HouseholdService) private readonly households: HouseholdService,
  ) {}
  @Get()
  @ApiResponse({ status: 200, type: HouseholdListResponseDto })
  async list(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Query() query: HouseholdPageQueryDto,
  ) {
    const page = await this.households.list(
      requestContextStore.requireActor(),
      vendorId,
      query,
    );
    return {
      items: page.items.map(toHouseholdResponse),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  @Post()
  @ApiResponse({ status: 201, type: HouseholdResponseDto })
  async create(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Body() body: CreateHouseholdRequestDto,
  ) {
    return toHouseholdResponse(
      await this.households.create(
        requestContextStore.requireActor(),
        vendorId,
        body,
      ),
    );
  }
  @Get(":id")
  @ApiResponse({ status: 200, type: HouseholdResponseDto })
  async get(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return toHouseholdResponse(
      await this.households.get(
        requestContextStore.requireActor(),
        vendorId,
        id,
      ),
    );
  }
  @Patch(":id")
  @ApiResponse({ status: 200, type: HouseholdResponseDto })
  async update(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateHouseholdRequestDto,
  ) {
    return toHouseholdResponse(
      await this.households.update(
        requestContextStore.requireActor(),
        vendorId,
        id,
        body,
      ),
    );
  }
  @Delete(":id") @HttpCode(204) async remove(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: VersionedReasonRequestDto,
  ) {
    await this.households.softDelete(
      requestContextStore.requireActor(),
      vendorId,
      id,
      body,
    );
  }
  @Post(":id/restore")
  @HttpCode(200)
  @ApiResponse({ status: 200, type: HouseholdResponseDto })
  async restore(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: VersionedReasonRequestDto,
  ) {
    return toHouseholdResponse(
      await this.households.restore(
        requestContextStore.requireActor(),
        vendorId,
        id,
        body,
      ),
    );
  }
  @Get(":id/members")
  @ApiResponse({ status: 200, type: HouseholdMemberListResponseDto })
  async members(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: HouseholdPageQueryDto,
  ) {
    const page = await this.households.listMembers(
      requestContextStore.requireActor(),
      vendorId,
      id,
      query,
    );
    return {
      items: page.items.map(toHouseholdMemberResponse),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  @Post(":id/members")
  @ApiResponse({ status: 201, type: HouseholdMemberResponseDto })
  async attach(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AttachHouseholdMemberRequestDto,
  ) {
    return toHouseholdMemberResponse(
      await this.households.attachMember(
        requestContextStore.requireActor(),
        vendorId,
        id,
        body.customerMembershipId,
      ),
    );
  }
  @Post(":id/members/:memberId/end")
  @HttpCode(200)
  @ApiResponse({ status: 200, type: HouseholdMemberResponseDto })
  async end(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("memberId", ParseUUIDPipe) memberId: string,
    @Body() body: EndHouseholdMemberRequestDto,
  ) {
    return toHouseholdMemberResponse(
      await this.households.endMember(
        requestContextStore.requireActor(),
        vendorId,
        id,
        memberId,
        body.reason,
      ),
    );
  }
}
@ApiTags("Customer households")
@ApiBearerAuth("opaqueBearer")
@ApiResponse({ status: 400, type: ApiErrorResponseDto })
@ApiResponse({ status: 401, type: ApiErrorResponseDto })
@ApiResponse({ status: 403, type: ApiErrorResponseDto })
@ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto })
@ApiResponse({ status: 503, type: ApiErrorResponseDto })
@UseGuards(ActorGuard)
@Controller("customer/vendors/:vendorId/households")
export class CustomerHouseholdController {
  constructor(
    @Inject(HouseholdService) private readonly households: HouseholdService,
  ) {}
  @Get()
  @ApiResponse({ status: 200, type: CustomerHouseholdListResponseDto })
  async list(
    @Param("vendorId", ParseUUIDPipe) vendorId: string,
    @Query() query: HouseholdPageQueryDto,
  ) {
    const page = await this.households.listForCustomer(
      requestContextStore.requireActor(),
      vendorId,
      query,
    );
    return {
      items: page.items.map(toCustomerHouseholdResponse),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}
for (const [target, key, types] of [
  [HouseholdController.prototype, "list", [String, HouseholdPageQueryDto]],
  [
    HouseholdController.prototype,
    "create",
    [String, CreateHouseholdRequestDto],
  ],
  [HouseholdController.prototype, "get", [String, String]],
  [
    HouseholdController.prototype,
    "update",
    [String, String, UpdateHouseholdRequestDto],
  ],
  [
    HouseholdController.prototype,
    "remove",
    [String, String, VersionedReasonRequestDto],
  ],
  [
    HouseholdController.prototype,
    "restore",
    [String, String, VersionedReasonRequestDto],
  ],
  [
    HouseholdController.prototype,
    "members",
    [String, String, HouseholdPageQueryDto],
  ],
  [
    HouseholdController.prototype,
    "attach",
    [String, String, AttachHouseholdMemberRequestDto],
  ],
  [
    HouseholdController.prototype,
    "end",
    [String, String, String, EndHouseholdMemberRequestDto],
  ],
  [
    CustomerHouseholdController.prototype,
    "list",
    [String, HouseholdPageQueryDto],
  ],
] as const)
  Reflect.defineMetadata("design:paramtypes", types, target, key);
