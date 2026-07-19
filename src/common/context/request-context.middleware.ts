import { createHmac, randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';

import { RequestContextStore } from './request-context.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RequestLike = Readonly<{
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  ip?: string;
}>;

type ResponseLike = {
  setHeader(name: string, value: string): unknown;
};

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly context: RequestContextStore,
    private readonly authHmacKey: Buffer,
  ) {}

  use(request: RequestLike, response: ResponseLike, next: () => void): void {
    const inboundCorrelationId = request.headers['x-correlation-id'];
    const correlationId =
      typeof inboundCorrelationId === 'string' &&
      UUID_PATTERN.test(inboundCorrelationId)
        ? inboundCorrelationId
        : randomUUID();

    response.setHeader('x-correlation-id', correlationId);
    const ipHash = request.ip
      ? createHmac('sha256', this.authHmacKey).update(request.ip).digest('hex')
      : undefined;
    this.context.run({ correlationId, ipHash }, next);
  }
}
