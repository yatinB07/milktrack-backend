import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ActorGuard } from '../../authorization/http/actor.guard.js';
import { RequestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import {
  AuthenticationService,
  type SessionTokens,
} from '../application/authentication.service.js';
import {
  AdminMfaRequestDto,
  AdminPasswordRequestDto,
  type ClientType,
  CurrentActorResponseDto,
  OtpChallengeResponseDto,
  PendingMfaResponseDto,
  RefreshRequestDto,
  RequestOtpRequestDto,
  SessionResponseDto,
  VerifyOtpRequestDto,
} from './auth.dto.js';

const REFRESH_COOKIE = 'milktrack_refresh';
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/v1/auth',
} as const;

type AuthRequest = Readonly<{
  cookies?: Readonly<Record<string, unknown>>;
}>;

type AuthResponse = {
  cookie(name: string, value: string, options: typeof REFRESH_COOKIE_OPTIONS): void;
  clearCookie(name: string, options: typeof REFRESH_COOKIE_OPTIONS): void;
};

function authenticationFailed(): ApplicationError {
  return new ApplicationError(
    'AUTHENTICATION_FAILED',
    'Authentication failed',
    401,
  );
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
    @Inject(RequestContextStore)
    private readonly context: RequestContextStore,
  ) {}

  @Post('otp/request')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request a phone sign-in challenge' })
  @ApiOkResponse({ type: OtpChallengeResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponseDto })
  async requestOtp(
    @Body() body: RequestOtpRequestDto,
  ): Promise<OtpChallengeResponseDto> {
    const result = await this.authentication.requestPhoneOtp({
      phone: body.phone,
      purpose: body.purpose,
      ipHash: this.context.require().ipHash,
    });
    return {
      accepted: result.accepted,
      challengeToken: result.challengeToken,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify a phone sign-in challenge' })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  async verifyOtp(
    @Body() body: VerifyOtpRequestDto,
    @Res({ passthrough: true }) response: AuthResponse,
  ): Promise<SessionResponseDto> {
    const tokens = await this.authentication.verifyPhoneOtp({
      challengeToken: body.challengeToken,
      code: body.code,
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      ipHash: this.context.require().ipHash,
    });
    return this.setSessionResponse(body.clientType, tokens, response);
  }

  @Post('admin/password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start administrator password sign-in' })
  @ApiOkResponse({ type: PendingMfaResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  async startAdministratorSignIn(
    @Body() body: AdminPasswordRequestDto,
  ): Promise<PendingMfaResponseDto> {
    const result = await this.authentication.startAdministratorSignIn({
      email: body.email,
      password: body.password,
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      ipHash: this.context.require().ipHash,
    });
    return {
      pendingMfaToken: result.pendingMfaToken,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  @Post('admin/mfa')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete administrator MFA sign-in' })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  async verifyAdministratorMfa(
    @Body() body: AdminMfaRequestDto,
    @Res({ passthrough: true }) response: AuthResponse,
  ): Promise<SessionResponseDto> {
    const tokens = await this.authentication.verifyAdministratorMfa({
      pendingMfaToken: body.pendingMfaToken,
      code: body.code,
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      ipHash: this.context.require().ipHash,
    });
    return this.setSessionResponse(body.clientType, tokens, response);
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotate a device-bound session',
    description:
      'Browser clients send the refresh token in the secure cookie; mobile clients send it in the request body.',
    security: [{ refreshCookie: [] }, {}],
  })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  async refresh(
    @Body() body: RefreshRequestDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: AuthResponse,
  ): Promise<SessionResponseDto> {
    const refreshToken = this.refreshToken(body, request);
    const tokens = await this.authentication.refresh(refreshToken, body.deviceId);
    return this.setSessionResponse(body.clientType, tokens, response);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(ActorGuard)
  @ApiOperation({ summary: 'Revoke the current session' })
  @ApiBearerAuth('opaqueBearer')
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  async logout(
    @Headers('authorization') authorization: string,
    @Res({ passthrough: true }) response: AuthResponse,
  ): Promise<void> {
    await this.authentication.logout(this.bearerToken(authorization));
    this.setSessionResponse('browser', undefined, response);
  }

  @Post('logout-all')
  @HttpCode(204)
  @UseGuards(ActorGuard)
  @ApiOperation({ summary: 'Revoke every session for the current actor' })
  @ApiBearerAuth('opaqueBearer')
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  async logoutAll(
    @Headers('authorization') authorization: string,
    @Res({ passthrough: true }) response: AuthResponse,
  ): Promise<void> {
    await this.authentication.logoutAll(this.bearerToken(authorization));
    this.setSessionResponse('browser', undefined, response);
  }

  @Get('me')
  @UseGuards(ActorGuard)
  @ApiOperation({ summary: 'Read the authenticated actor' })
  @ApiBearerAuth('opaqueBearer')
  @ApiOkResponse({ type: CurrentActorResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  me(): CurrentActorResponseDto {
    const actor = this.context.requireActor();
    return {
      userId: actor.userId,
      displayName: actor.displayName,
      platformRoles: [...actor.platformRoles],
      memberships: actor.memberships.map((membership) => ({
        id: membership.id,
        vendorId: membership.vendorId,
        vendorName: membership.vendorName,
        role: membership.role,
        status: membership.status,
      })),
      sessionId: actor.sessionId,
    };
  }

  private refreshToken(body: RefreshRequestDto, request: AuthRequest): string {
    const token =
      body.clientType === 'browser'
        ? request.cookies?.[REFRESH_COOKIE]
        : body.refreshToken;
    if (typeof token !== 'string') throw authenticationFailed();
    return token;
  }

  private bearerToken(authorization: string): string {
    return authorization.slice('Bearer '.length);
  }

  private setSessionResponse(
    clientType: ClientType,
    tokens: SessionTokens,
    response: AuthResponse,
  ): SessionResponseDto;
  private setSessionResponse(
    clientType: ClientType,
    tokens: undefined,
    response: AuthResponse,
  ): void;
  private setSessionResponse(
    clientType: ClientType,
    tokens: SessionTokens | undefined,
    response: AuthResponse,
  ): SessionResponseDto | void {
    if (!tokens) {
      response.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
      return;
    }
    if (clientType === 'browser') {
      response.cookie(REFRESH_COOKIE, tokens.refreshToken, REFRESH_COOKIE_OPTIONS);
    }
    return {
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.accessExpiresAt.toISOString(),
      refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
      ...(clientType === 'mobile' ? { refreshToken: tokens.refreshToken } : {}),
    };
  }
}
