import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import { RequestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { AuthenticationService } from '../../identity/application/authentication.service.js';

type RequestWithHeaders = Readonly<{
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}>;

const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

function unauthenticated(): ApplicationError {
  return new ApplicationError(
    'UNAUTHENTICATED',
    'Authentication is required',
    401,
  );
}

@Injectable()
export class ActorGuard implements CanActivate {
  constructor(
    private readonly authentication: AuthenticationService,
    private readonly context: RequestContextStore,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<true> {
    const request = executionContext.switchToHttp().getRequest<RequestWithHeaders>();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string') throw unauthenticated();
    const token = BEARER_PATTERN.exec(authorization)?.[1];
    if (!token) throw unauthenticated();

    try {
      this.context.replaceActor(await this.authentication.authenticate(token));
      return true;
    } catch (error) {
      if (error instanceof ApplicationError && error.status === 401) {
        throw unauthenticated();
      }
      throw error;
    }
  }
}
