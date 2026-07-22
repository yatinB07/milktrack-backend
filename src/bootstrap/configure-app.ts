import { isIP } from 'node:net';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { RequestContextMiddleware } from '../common/context/request-context.middleware.js';
import { requestContextStore } from '../common/context/request-context.js';
import { ApplicationErrorFilter } from '../common/errors/application-error.filter.js';

const agentOutcomePath =
  '/v1/agent/vendors/{vendorId}/route-stops/{routeStopId}/outcomes';
const agentOutcomeSchema = 'AgentStopOutcomeRequestDto';
const agentOutcomeVariantRefs = [
  '#/components/schemas/DeliveredAgentStopOutcomeDto',
  '#/components/schemas/MissedAgentStopOutcomeDto',
  '#/components/schemas/SkippedAgentStopOutcomeDto',
] as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OpenAPI ${label} is missing or invalid`);
  }
  return value as Record<string, unknown>;
}

/** Nest Swagger cannot decorate a named class as a root discriminated union. */
function publishAgentOutcomeSchema(document: OpenAPIObject): void {
  const components = object(document.components, 'components');
  const schemas = object(components.schemas, 'component schemas');
  const paths = object(document.paths, 'paths');
  const path = paths[agentOutcomePath];
  const component = schemas[agentOutcomeSchema];
  if (path === undefined && component === undefined) return;
  object(component, agentOutcomeSchema);
  for (const reference of agentOutcomeVariantRefs) {
    object(schemas[reference.split('/').at(-1)!], reference);
  }

  const operation = object(object(path, agentOutcomePath).post, `${agentOutcomePath} POST`);
  const requestBody = object(operation.requestBody, 'agent outcome request body');
  const content = object(requestBody.content, 'agent outcome request content');
  const media = object(content['application/json'], 'agent outcome JSON media type');
  const inline = object(media.schema, 'agent outcome inline schema');
  const discriminator = object(inline.discriminator, 'agent outcome discriminator');
  const variants = inline.oneOf;
  if (discriminator.propertyName !== 'outcome' || !Array.isArray(variants) || variants.length !== 3) {
    throw new Error('OpenAPI agent outcome union is missing or invalid');
  }
  const references = variants.map((variant, index) => {
    const allOf = object(variant, `agent outcome variant ${index}`).allOf;
    if (!Array.isArray(allOf) || allOf.length === 0) {
      throw new Error(`OpenAPI agent outcome variant ${index} is missing allOf`);
    }
    const reference = object(allOf[0], `agent outcome variant ${index} reference`).$ref;
    if (typeof reference !== 'string') {
      throw new Error(`OpenAPI agent outcome variant ${index} reference is invalid`);
    }
    return reference;
  }).sort();
  if (new Set(references).size !== 3 || references.some((reference, index) => reference !== agentOutcomeVariantRefs[index])) {
    throw new Error('OpenAPI agent outcome variants do not match the frozen contract');
  }

  const { title: _title, ...union } = inline;
  void _title;
  schemas[agentOutcomeSchema] = union;
  media.schema = { $ref: `#/components/schemas/${agentOutcomeSchema}` };

  const published = object(schemas[agentOutcomeSchema], agentOutcomeSchema);
  if (object(published.discriminator, 'published agent outcome discriminator').propertyName !== 'outcome'
    || !Array.isArray(published.oneOf) || published.oneOf.length !== 3
    || object(media.schema, 'published agent outcome request schema').$ref !== `#/components/schemas/${agentOutcomeSchema}`) {
    throw new Error('OpenAPI agent outcome schema publication failed');
  }
}

export function parseTrustedProxyCidrs(
  value: string | undefined,
): readonly string[] {
  if (!value?.trim()) return [];

  const cidrs = value.split(',').map((entry) => entry.trim());
  for (const cidr of cidrs) {
    const parts = cidr.split('/');
    const version = isIP(parts[0] ?? '');
    const prefix = parts[1];
    const maximumPrefix = version === 4 ? 32 : 128;
    if (
      parts.length > 2 ||
      version === 0 ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > maximumPrefix))
    ) {
      throw new Error('TRUST_PROXY_CIDRS must contain only valid IP CIDRs');
    }
  }
  return cidrs;
}

export function configureApp(
  app: INestApplication,
  authHmacKey: Buffer,
  trustedProxyCidrs: readonly string[] = [],
): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    set(name: 'trust proxy', value: false | readonly string[]): void;
  };
  expressApp.set(
    'trust proxy',
    trustedProxyCidrs.length === 0 ? false : trustedProxyCidrs,
  );
  app.setGlobalPrefix('v1');
  app.use(helmet());
  app.use(cookieParser());
  const requestContextMiddleware = new RequestContextMiddleware(
    requestContextStore,
    authHmacKey,
  );
  app.use(requestContextMiddleware.use.bind(requestContextMiddleware));
  app.useGlobalFilters(new ApplicationErrorFilter(requestContextStore));
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const document = createOpenApiDocument(app);
  SwaggerModule.setup('openapi', app, document, {
    jsonDocumentUrl: 'openapi.json',
  });
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('MilkTrack API')
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
        'opaqueBearer',
      )
      .addCookieAuth(
        'milktrack_refresh',
        { type: 'apiKey', in: 'cookie' },
        'refreshCookie',
      )
      .build(),
  );
  publishAgentOutcomeSchema(document);
  return document;
}
