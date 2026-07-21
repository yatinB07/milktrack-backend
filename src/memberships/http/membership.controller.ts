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

import { ActorGuard } from '../../identity/http/actor.guard.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { LifecycleQueryDto } from '../../common/http/record-lifecycle.dto.js';
import {
  UserLifecycleService,
  type UserResult,
} from '../../identity/application/user-lifecycle.service.js';
import {
  type MembershipPage,
  type MembershipResult,
  MembershipService,
} from '../application/membership.service.js';
import { OwnerEnrollmentService } from '../application/owner-enrollment.service.js';
import { VendorOwnerOnboardingService } from '../application/vendor-owner-onboarding.service.js';
import {
  CompleteOwnerEnrollmentRequestDto,
  CompleteOwnerEnrollmentResponseDto,
  CreateMembershipRequestDto,
  EstablishVendorOwnerRequestDto,
  ListMembershipsQueryDto,
  MembershipPageResponseDto,
  MembershipDirectoryResponseDto,
  MembershipResponseDto,
  OnboardMembershipRequestDto,
  ReasonRequestDto,
  RetryOwnerEnrollmentResponseDto,
  StartOwnerEnrollmentRequestDto,
  StartOwnerEnrollmentResponseDto,
  UpdateMembershipRoleRequestDto,
  UserResponseDto,
  VendorOwnerOnboardingResponseDto,
  VendorOwnerOnboardingStatusResponseDto,
} from './membership.dto.js';

const uuidPipe = new ParseUUIDPipe({ version: '4' });

function membershipResponse(result: MembershipResult): MembershipResponseDto {
  return {
    id: result.id,
    vendorId: result.vendorId,
    userId: result.userId,
    role: result.role,
    status: result.status,
    lifecycle: result.lifecycle,
    ...(result.joinedAt ? { joinedAt: result.joinedAt } : {}),
    ...(result.endedAt ? { endedAt: result.endedAt } : {}),
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  };
}

function directoryMembershipResponse(result: MembershipResult & { displayName: string; phone?: string; email?: string }) {
  return {
    ...membershipResponse(result),
    displayName: result.displayName,
    ...(result.phone ? { phone: result.phone } : {}),
    ...(result.email ? { email: result.email } : {}),
  };
}

function membershipPageResponse(page: MembershipPage): MembershipPageResponseDto {
  return {
    items: page.items.map(directoryMembershipResponse),
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
    ...(result.deactivatedAt ? { deactivatedAt: result.deactivatedAt } : {}),
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
      { ...query, lifecycle: query.lifecycle ?? 'current' },
    );
    return membershipPageResponse(page);
  }

  @Get(':id')
  @ApiOkResponse({ type: MembershipDirectoryResponseDto })
  async get(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Param('id', uuidPipe) membershipId: string,
    @Query() query: LifecycleQueryDto,
  ) {
    return directoryMembershipResponse(
      await this.memberships.get(
        requestContextStore.requireActor(),
        vendorId,
        membershipId,
        query.lifecycle ?? 'current',
      ),
    );
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

  @Post('onboard')
  @ApiCreatedResponse({ type: MembershipDirectoryResponseDto })
  @ApiResponse({
    status: 503,
    type: ApiErrorResponseDto,
    description: 'Security audit unavailable (SECURITY_AUDIT_UNAVAILABLE)',
  })
  async onboard(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Body() request: OnboardMembershipRequestDto,
  ) {
    return directoryMembershipResponse(
      await this.memberships.onboard(
        requestContextStore.requireActor(),
        vendorId,
        request,
      ),
    );
  }

  @Patch(':id')
  @ApiOkResponse({ type: MembershipResponseDto })
  @ApiResponse({
    status: 409,
    type: ApiErrorResponseDto,
    description:
      'Customer and delivery agent roles require onboarding (MEMBERSHIP_ONBOARDING_REQUIRED)',
  })
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

  @Post(':id/deactivate')
  @HttpCode(200)
  @ApiOkResponse({ type: UserResponseDto })
  async deactivate(
    @Param('id', uuidPipe) userId: string,
    @Body() request: ReasonRequestDto,
  ) {
    return userResponse(
      await this.users.deactivate(
        requestContextStore.requireActor(),
        userId,
        request.reason,
      ),
    );
  }
}

@ApiTags('Platform vendor owners')
@ApiBearerAuth('opaqueBearer')
@ApiResponse({ status: 400, type: ApiErrorResponseDto })
@ApiResponse({ status: 401, type: ApiErrorResponseDto })
@ApiResponse({ status: 403, type: ApiErrorResponseDto })
@ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto })
@ApiResponse({ status: 503, type: ApiErrorResponseDto })
@UseGuards(ActorGuard)
@Controller('platform/vendors/:vendorId/owners')
export class VendorOwnerOnboardingController {
  constructor(
    @Inject(VendorOwnerOnboardingService)
    private readonly onboarding: VendorOwnerOnboardingService,
  ) {}

  @Get('initial')
  @ApiOkResponse({ type: VendorOwnerOnboardingStatusResponseDto })
  async status(
    @Param('vendorId', uuidPipe) vendorId: string,
  ): Promise<VendorOwnerOnboardingStatusResponseDto> {
    const result = await this.onboarding.status(
      requestContextStore.requireActor(),
      vendorId,
    );
    return {
      vendorId: result.vendorId,
      state: result.state,
      ...(result.enrollmentId ? { enrollmentId: result.enrollmentId } : {}),
      ...(result.membershipId ? { membershipId: result.membershipId } : {}),
      ...(result.ownerDisplayName ? { ownerDisplayName: result.ownerDisplayName } : {}),
      ...(result.ownerEmail ? { ownerEmail: result.ownerEmail } : {}),
      ...(result.expiresAt ? { expiresAt: result.expiresAt.toISOString() } : {}),
    };
  }

  @Post('initial')
  @ApiCreatedResponse({ type: VendorOwnerOnboardingResponseDto })
  async establish(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Body() request: EstablishVendorOwnerRequestDto,
  ) {
    const result = await this.onboarding.establish(requestContextStore.requireActor(), {
      vendorId,
      email: request.email,
      displayName: request.displayName,
      reason: request.reason,
    });
    return {
      vendorId: result.vendorId,
      userId: result.userId,
      membershipId: result.membershipId,
      enrollmentId: result.enrollmentId,
      email: result.email,
      createdUser: result.createdUser,
      expiresAt: result.expiresAt.toISOString(),
      deliveryStatus: result.deliveryStatus,
    } satisfies VendorOwnerOnboardingResponseDto;
  }

  @Post('enrollments/:enrollmentId/retry')
  @HttpCode(200)
  @ApiOkResponse({ type: RetryOwnerEnrollmentResponseDto })
  async retry(
    @Param('vendorId', uuidPipe) vendorId: string,
    @Param('enrollmentId', uuidPipe) enrollmentId: string,
    @Body() request: ReasonRequestDto,
  ): Promise<RetryOwnerEnrollmentResponseDto> {
    const result = await this.onboarding.retry(requestContextStore.requireActor(), {
      vendorId,
      enrollmentId,
      reason: request.reason,
    });
    return {
      enrollmentId: result.enrollmentId,
      membershipId: result.membershipId,
      expiresAt: result.expiresAt.toISOString(),
      deliveryStatus: result.deliveryStatus,
    };
  }
}

@ApiTags('Owner enrollment')
@ApiResponse({ status: 400, type: ApiErrorResponseDto })
@ApiResponse({ status: 401, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto })
@Controller('auth/owner-enrollment')
export class OwnerEnrollmentController {
  constructor(
    @Inject(OwnerEnrollmentService)
    private readonly enrollment: OwnerEnrollmentService,
  ) {}

  @Post('start')
  @HttpCode(200)
  @ApiOkResponse({ type: StartOwnerEnrollmentResponseDto })
  async start(
    @Body() request: StartOwnerEnrollmentRequestDto,
  ): Promise<StartOwnerEnrollmentResponseDto> {
    const result = await this.enrollment.start(request.setupToken, request.password);
    return {
      completionToken: result.completionToken,
      totpSecret: result.totpSecret,
    };
  }

  @Post('complete')
  @HttpCode(200)
  @ApiOkResponse({ type: CompleteOwnerEnrollmentResponseDto })
  async complete(
    @Body() request: CompleteOwnerEnrollmentRequestDto,
  ): Promise<CompleteOwnerEnrollmentResponseDto> {
    const result = await this.enrollment.complete(
      request.completionToken,
      request.code,
    );
    return {
      vendorId: result.vendorId,
      userId: result.userId,
      membershipId: result.membershipId,
    };
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
  [String, String, LifecycleQueryDto],
  MembershipController.prototype,
  'get',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [String, CreateMembershipRequestDto],
  MembershipController.prototype,
  'create',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [String, OnboardMembershipRequestDto],
  MembershipController.prototype,
  'onboard',
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
for (const method of ['softDelete', 'restore', 'deactivate'] as const) {
  Reflect.defineMetadata(
    'design:paramtypes',
    [String, ReasonRequestDto],
    UserLifecycleController.prototype,
    method,
  );
}
Reflect.defineMetadata(
  'design:paramtypes',
  [String],
  VendorOwnerOnboardingController.prototype,
  'status',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [String, EstablishVendorOwnerRequestDto],
  VendorOwnerOnboardingController.prototype,
  'establish',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [String, String, ReasonRequestDto],
  VendorOwnerOnboardingController.prototype,
  'retry',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [StartOwnerEnrollmentRequestDto],
  OwnerEnrollmentController.prototype,
  'start',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [CompleteOwnerEnrollmentRequestDto],
  OwnerEnrollmentController.prototype,
  'complete',
);
