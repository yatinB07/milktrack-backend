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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ActorGuard } from '../../authorization/http/actor.guard.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import {
  UserLifecycleService,
  type UserResult,
} from '../../identity/application/user-lifecycle.service.js';
import {
  type MembershipPage,
  type MembershipResult,
  MembershipService,
} from '../application/membership.service.js';
import {
  CreateMembershipRequestDto,
  ListMembershipsQueryDto,
  MembershipPageResponseDto,
  MembershipResponseDto,
  ReasonRequestDto,
  UpdateMembershipRoleRequestDto,
  UserResponseDto,
} from './membership.dto.js';

const uuidPipe = new ParseUUIDPipe({ version: '4' });

function membershipResponse(result: MembershipResult): MembershipResponseDto {
  return {
    id: result.id,
    vendorId: result.vendorId,
    userId: result.userId,
    role: result.role,
    status: result.status,
    ...(result.joinedAt ? { joinedAt: result.joinedAt } : {}),
    ...(result.endedAt ? { endedAt: result.endedAt } : {}),
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  };
}

function membershipPageResponse(page: MembershipPage): MembershipPageResponseDto {
  return {
    items: page.items.map(membershipResponse),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

function userResponse(result: UserResult): UserResponseDto {
  return {
    id: result.id,
    displayName: result.displayName,
    status: result.status,
    locale: result.locale,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  };
}

@ApiTags('Vendor memberships')
@ApiBearerAuth('opaqueBearer')
@ApiResponse({ status: 400, type: ApiErrorResponseDto })
@ApiResponse({ status: 401, type: ApiErrorResponseDto })
@ApiResponse({ status: 403, type: ApiErrorResponseDto })
@ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto })
@UseGuards(ActorGuard)
@Controller('vendors/:vendorId/memberships')
export class MembershipController {
  constructor(
    @Inject(MembershipService)
    private readonly memberships: MembershipService,
  ) {}

  @Get()
  @ApiOkResponse({ type: MembershipPageResponseDto })
  async list(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Query() query: ListMembershipsQueryDto,
  ) {
    const page = await this.memberships.list(
      requestContextStore.requireActor(),
      vendorId,
      query,
    );
    return membershipPageResponse(page);
  }

  @Post()
  @ApiCreatedResponse({ type: MembershipResponseDto })
  async create(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Body() request: CreateMembershipRequestDto,
  ) {
    const result = await this.memberships.create(
      requestContextStore.requireActor(),
      vendorId,
      request,
    );
    return membershipResponse(result);
  }

  @Patch(':id')
  @ApiOkResponse({ type: MembershipResponseDto })
  async updateRole(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Param('id', uuidPipe) membershipId: string,
    @Body() request: UpdateMembershipRoleRequestDto,
  ) {
    const result = await this.memberships.updateRole(
      requestContextStore.requireActor(),
      vendorId,
      membershipId,
      request.role,
    );
    return membershipResponse(result);
  }

  @Post(':id/end')
  @HttpCode(200)
  @ApiOkResponse({ type: MembershipResponseDto })
  async end(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Param('id', uuidPipe) membershipId: string,
    @Body() request: ReasonRequestDto,
  ) {
    const result = await this.memberships.end(
      requestContextStore.requireActor(),
      vendorId,
      membershipId,
      request.reason,
    );
    return membershipResponse(result);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse()
  async softDelete(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Param('id', uuidPipe) membershipId: string,
    @Body() request: ReasonRequestDto,
  ): Promise<void> {
    await this.memberships.softDelete(
      requestContextStore.requireActor(),
      vendorId,
      membershipId,
      request.reason,
    );
  }

  @Post(':id/restore')
  @HttpCode(200)
  @ApiOkResponse({ type: MembershipResponseDto })
  async restore(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Param('id', uuidPipe) membershipId: string,
    @Body() request: ReasonRequestDto,
  ) {
    const result = await this.memberships.restore(
      requestContextStore.requireActor(),
      vendorId,
      membershipId,
      request.reason,
    );
    return membershipResponse(result);
  }
}

@ApiTags('Platform users')
@ApiBearerAuth('opaqueBearer')
@ApiResponse({ status: 400, type: ApiErrorResponseDto })
@ApiResponse({ status: 401, type: ApiErrorResponseDto })
@ApiResponse({ status: 403, type: ApiErrorResponseDto })
@ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto })
@UseGuards(ActorGuard)
@Controller('platform/users')
export class UserLifecycleController {
  constructor(
    @Inject(UserLifecycleService)
    private readonly users: UserLifecycleService,
  ) {}

  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse()
  async softDelete(
    @Param('id', uuidPipe) userId: string,
    @Body() request: ReasonRequestDto,
  ): Promise<void> {
    await this.users.softDelete(
      requestContextStore.requireActor(),
      userId,
      request.reason,
    );
  }

  @Post(':id/restore')
  @HttpCode(200)
  @ApiOkResponse({ type: UserResponseDto })
  async restore(
    @Param('id', uuidPipe) userId: string,
    @Body() request: ReasonRequestDto,
  ) {
    const result = await this.users.restore(
      requestContextStore.requireActor(),
      userId,
      request.reason,
    );
    return userResponse(result);
  }
}

// The integration runner uses tsx, which does not emit decorator parameter metadata.
Reflect.defineMetadata(
  'design:paramtypes',
  [String, ListMembershipsQueryDto],
  MembershipController.prototype,
  'list',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [String, CreateMembershipRequestDto],
  MembershipController.prototype,
  'create',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [String, String, UpdateMembershipRoleRequestDto],
  MembershipController.prototype,
  'updateRole',
);
for (const method of ['end', 'softDelete', 'restore'] as const) {
  Reflect.defineMetadata(
    'design:paramtypes',
    [String, String, ReasonRequestDto],
    MembershipController.prototype,
    method,
  );
}
for (const method of ['softDelete', 'restore'] as const) {
  Reflect.defineMetadata(
    'design:paramtypes',
    [String, ReasonRequestDto],
    UserLifecycleController.prototype,
    method,
  );
}
