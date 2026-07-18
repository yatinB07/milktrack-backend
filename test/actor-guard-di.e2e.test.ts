import assert from 'node:assert/strict';
import { it } from 'node:test';

import { Module, type ExecutionContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ActorGuard } from '../src/identity/http/actor.guard.js';
import {
  type Actor,
  RequestContextStore,
} from '../src/common/context/request-context.js';
import { AuthenticationService } from '../src/identity/application/authentication.service.js';

const actor: Actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Product Owner',
  authenticationMethod: 'administrator_mfa',
  platformRoles: ['product_owner'],
  memberships: [],
};

const context = new RequestContextStore();
const authentication = { authenticate: () => Promise.resolve(actor) };

@Module({
  providers: [
    ActorGuard,
    { provide: AuthenticationService, useValue: authentication },
    { provide: RequestContextStore, useValue: context },
  ],
})
class GuardDiTestModule {}

void it('resolves ActorGuard dependencies from explicit Nest injection tokens', async () => {
  const app = await NestFactory.createApplicationContext(GuardDiTestModule, {
    abortOnError: false,
    logger: false,
  });
  try {
    const guard = app.get(ActorGuard);
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: 'Bearer opaque' } }),
      }),
    } as ExecutionContext;

    await context.run({ correlationId: 'correlation-id' }, async () => {
      await guard.canActivate(executionContext);
      assert.equal(context.requireActor(), actor);
    });
  } finally {
    await app.close();
  }
});
