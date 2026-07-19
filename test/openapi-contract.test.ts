import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

type JsonObject = Record<string, unknown>;

const phaseOneOperations = {
  '/v1/auth/admin/mfa': ['post'],
  '/v1/auth/admin/password': ['post'],
  '/v1/auth/owner-enrollment/complete': ['post'],
  '/v1/auth/owner-enrollment/start': ['post'],
  '/v1/auth/logout': ['post'],
  '/v1/auth/logout-all': ['post'],
  '/v1/auth/me': ['get'],
  '/v1/auth/otp/request': ['post'],
  '/v1/auth/otp/verify': ['post'],
  '/v1/auth/refresh': ['post'],
  '/v1/health': ['get'],
  '/v1/platform/users/{id}': ['delete'],
  '/v1/platform/users/{id}/deactivate': ['post'],
  '/v1/platform/users/{id}/restore': ['post'],
  '/v1/platform/vendors': ['get', 'post'],
  '/v1/platform/vendors/{id}': ['get'],
  '/v1/platform/vendors/{id}/transitions': ['post'],
  '/v1/platform/vendors/{vendorId}/owners/initial': ['get', 'post'],
  '/v1/platform/vendors/{vendorId}/owners/enrollments/{enrollmentId}/retry': ['post'],
  '/v1/vendors/{vendorId}/audit-events': ['get'],
  '/v1/vendors/{vendorId}/memberships': ['get', 'post'],
  '/v1/vendors/{vendorId}/memberships/{id}': ['delete', 'patch'],
  '/v1/vendors/{vendorId}/memberships/{id}/end': ['post'],
  '/v1/vendors/{vendorId}/memberships/{id}/restore': ['post'],
  '/v1/vendors/{vendorId}/profile': ['get'],
} as const;

const bodyOperations = new Set([
  'post /v1/auth/admin/mfa',
  'post /v1/auth/admin/password',
  'post /v1/auth/owner-enrollment/complete',
  'post /v1/auth/owner-enrollment/start',
  'post /v1/auth/otp/request',
  'post /v1/auth/otp/verify',
  'post /v1/auth/refresh',
  'delete /v1/platform/users/{id}',
  'post /v1/platform/users/{id}/deactivate',
  'post /v1/platform/users/{id}/restore',
  'post /v1/platform/vendors',
  'post /v1/platform/vendors/{id}/transitions',
  'post /v1/platform/vendors/{vendorId}/owners/initial',
  'post /v1/platform/vendors/{vendorId}/owners/enrollments/{enrollmentId}/retry',
  'post /v1/vendors/{vendorId}/memberships',
  'delete /v1/vendors/{vendorId}/memberships/{id}',
  'patch /v1/vendors/{vendorId}/memberships/{id}',
  'post /v1/vendors/{vendorId}/memberships/{id}/end',
  'post /v1/vendors/{vendorId}/memberships/{id}/restore',
]);

const protectedOperations = new Set([
  'post /v1/auth/logout',
  'post /v1/auth/logout-all',
  'get /v1/auth/me',
  'delete /v1/platform/users/{id}',
  'post /v1/platform/users/{id}/deactivate',
  'post /v1/platform/users/{id}/restore',
  'get /v1/platform/vendors',
  'post /v1/platform/vendors',
  'get /v1/platform/vendors/{id}',
  'post /v1/platform/vendors/{id}/transitions',
  'get /v1/platform/vendors/{vendorId}/owners/initial',
  'post /v1/platform/vendors/{vendorId}/owners/initial',
  'post /v1/platform/vendors/{vendorId}/owners/enrollments/{enrollmentId}/retry',
  'get /v1/vendors/{vendorId}/audit-events',
  'get /v1/vendors/{vendorId}/memberships',
  'post /v1/vendors/{vendorId}/memberships',
  'delete /v1/vendors/{vendorId}/memberships/{id}',
  'patch /v1/vendors/{vendorId}/memberships/{id}',
  'post /v1/vendors/{vendorId}/memberships/{id}/end',
  'post /v1/vendors/{vendorId}/memberships/{id}/restore',
  'get /v1/vendors/{vendorId}/profile',
]);

const anonymousOperations = new Set([
  'get /v1/health',
  'post /v1/auth/admin/mfa',
  'post /v1/auth/admin/password',
  'post /v1/auth/owner-enrollment/complete',
  'post /v1/auth/owner-enrollment/start',
  'post /v1/auth/otp/request',
  'post /v1/auth/otp/verify',
]);

function object(value: unknown, message: string): JsonObject {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), message);
  return value as JsonObject;
}

function responseHasSchema(response: unknown): boolean {
  const content = object(response, 'response must be an object').content;
  if (content === undefined) return false;
  return object(object(content, 'response content must be an object')['application/json'], 'JSON response must be documented').schema !== undefined;
}

function responseSchema(response: unknown, message: string): JsonObject {
  const content = object(object(response, message).content, `${message} content must be documented`);
  return object(object(content['application/json'], `${message} must document JSON`).schema, `${message} schema must be documented`);
}

function assertPhaseOneSecurity(document: JsonObject): void {
  const paths = object(document.paths, 'OpenAPI paths must be documented');
  for (const operationKey of protectedOperations) {
    const separator = operationKey.indexOf(' ');
    const method = operationKey.slice(0, separator);
    const path = operationKey.slice(separator + 1);
    const operation = object(
      object(paths[path], `missing OpenAPI path ${path}`)[method],
      `missing ${method.toUpperCase()} ${path}`,
    );
    assert.deepEqual(
      operation.security,
      [{ opaqueBearer: [] }],
      `${method.toUpperCase()} ${path} must require only opaque bearer authentication`,
    );
  }

  for (const operationKey of anonymousOperations) {
    const separator = operationKey.indexOf(' ');
    const method = operationKey.slice(0, separator);
    const path = operationKey.slice(separator + 1);
    const operation = object(
      object(paths[path], `missing OpenAPI path ${path}`)[method],
      `missing ${method.toUpperCase()} ${path}`,
    );
    assert.equal(
      operation.security,
      undefined,
      `${method.toUpperCase()} ${path} must remain anonymous`,
    );
  }
}

async function readDocument(): Promise<{ document: JsonObject; serialized: string }> {
  const serialized = await readFile(new URL('../openapi/v1.json', import.meta.url), 'utf8');
  return {
    document: object(JSON.parse(serialized), 'OpenAPI document must be an object'),
    serialized,
  };
}

void test('security contract rejects a protected operation without bearer authentication', async () => {
  const { document } = await readDocument();
  const mutated = structuredClone(document);
  const paths = object(mutated.paths, 'OpenAPI paths must be documented');
  delete object(object(paths['/v1/auth/logout'], 'logout path must exist').post, 'logout operation must exist').security;

  assert.throws(() => assertPhaseOneSecurity(mutated), /POST \/v1\/auth\/logout/);
});

void test('security contract rejects bearer authentication on an anonymous operation', async () => {
  const { document } = await readDocument();
  const mutated = structuredClone(document);
  const paths = object(mutated.paths, 'OpenAPI paths must be documented');
  object(object(paths['/v1/health'], 'health path must exist').get, 'health operation must exist').security = [
    { opaqueBearer: [] },
  ];

  assert.throws(() => assertPhaseOneSecurity(mutated), /GET \/v1\/health/);
});

void test('publishes the complete Phase 1 HTTP contract without persistence secrets', async () => {
  const { document, serialized } = await readDocument();
  const paths = object(document.paths, 'OpenAPI paths must be documented');
  assert.deepEqual(Object.keys(paths).sort(), Object.keys(phaseOneOperations).sort());

  for (const [path, methods] of Object.entries(phaseOneOperations)) {
    const pathItem = object(paths[path], `missing OpenAPI path ${path}`);
    for (const method of methods) {
      const operation = object(pathItem[method], `missing ${method.toUpperCase()} ${path}`);
      const responses = object(operation.responses, `${method.toUpperCase()} ${path} must document responses`);
      const success = Object.entries(responses).find(([status]) => status.startsWith('2'));
      assert(success, `${method.toUpperCase()} ${path} must document a success response`);
      if (success[0] !== '204') {
        assert(responseHasSchema(success[1]), `${method.toUpperCase()} ${path} success response must have a JSON schema`);
      }

      if (path !== '/v1/health') {
        const error = Object.entries(responses).find(([status]) => /^[45]/.test(status));
        assert(error && responseHasSchema(error[1]), `${method.toUpperCase()} ${path} must document an error schema`);
      }

      if (bodyOperations.has(`${method} ${path}`)) {
        const requestBody = object(operation.requestBody, `${method.toUpperCase()} ${path} must document its request body`);
        const content = object(requestBody.content, `${method.toUpperCase()} ${path} request body must have content`);
        assert(object(content['application/json'], `${method.toUpperCase()} ${path} must accept JSON`).schema);
      }
    }
  }

  for (const path of ['/v1/platform/vendors', '/v1/vendors/{vendorId}/audit-events', '/v1/vendors/{vendorId}/memberships']) {
    const operation = object(object(paths[path], `missing ${path}`).get, `missing GET ${path}`);
    const parameters = operation.parameters as JsonObject[];
    assert(Array.isArray(parameters), `GET ${path} must document query parameters`);
    const limit = parameters.find((parameter) => parameter.name === 'limit');
    assert(limit, `GET ${path} must document limit`);
    const schema = object(limit.schema, `GET ${path} limit must have a schema`);
    assert.equal(schema.default, 25);
    assert.equal(schema.minimum, 1);
    assert.equal(schema.maximum, 100);
  }

  const vendorList = object(object(paths['/v1/platform/vendors'], 'vendor list path must exist').get, 'vendor list operation must exist');
  const vendorSearch = (vendorList.parameters as JsonObject[]).find((parameter) => parameter.name === 'search');
  assert(vendorSearch, 'GET /v1/platform/vendors must document search');
  const vendorSearchSchema = object(vendorSearch.schema, 'GET /v1/platform/vendors search must have a schema');
  assert.equal(vendorSearchSchema.type, 'string');
  assert.equal(vendorSearchSchema.minLength, 1);
  assert.equal(vendorSearchSchema.maxLength, 120);
  assert.equal(vendorSearchSchema.pattern, '\\S');

  const components = object(document.components, 'OpenAPI components must be documented');
  const securitySchemes = object(components.securitySchemes, 'security schemes must be documented');
  assert(securitySchemes.opaqueBearer);
  assert(securitySchemes.refreshCookie);
  assert.deepEqual(
    object(object(paths['/v1/auth/refresh'], 'refresh path must exist').post, 'refresh operation must exist').security,
    [{ refreshCookie: [] }, {}],
  );
  assertPhaseOneSecurity(document);

  for (const [path, methods] of Object.entries(phaseOneOperations)) {
    assert.deepEqual(
      Object.keys(object(paths[path], `missing ${path}`)).sort(),
      [...methods].sort(),
      `${path} must publish only approved methods`,
    );
  }

  const normalized = serialized.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
  for (const forbidden of ['passwordHash', 'codeHash', 'refreshTokenHash', 'encryptedSecret', 'Prisma']) {
    assert(!normalized.includes(forbidden.toLowerCase()), `OpenAPI must not expose ${forbidden}`);
  }

  const schemas = object(components.schemas, 'OpenAPI schemas must be documented');
  const vendorProperties = object(
    object(schemas.VendorResponseDto, 'VendorResponseDto must be documented').properties,
    'VendorResponseDto properties must be documented',
  );
  assert.equal(object(vendorProperties.id, 'vendor id must be documented').format, 'uuid');
  assert.equal(object(vendorProperties.createdAt, 'createdAt must be documented').format, 'date-time');
  assert.equal(object(vendorProperties.updatedAt, 'updatedAt must be documented').format, 'date-time');
  assert.deepEqual(
    object(vendorProperties.allowedTransitions, 'allowedTransitions must be documented'),
    {
      items: {
        enum: ['pending_approval', 'onboarding', 'trial', 'active', 'suspended', 'closed'],
        type: 'string',
      },
      type: 'array',
    },
  );
  assert.deepEqual(
    object(schemas.VendorResponseDto, 'VendorResponseDto must be documented').required,
    [
      'id',
      'status',
      'allowedTransitions',
      'createdAt',
      'updatedAt',
      'code',
      'legalName',
      'displayName',
      'timezone',
      'currency',
      'skipCutoffMinutes',
      'billingDay',
      'version',
    ],
  );

  const ownerOnboardingStatus = object(
    object(schemas.VendorOwnerOnboardingStatusResponseDto, 'VendorOwnerOnboardingStatusResponseDto must be documented').properties,
    'VendorOwnerOnboardingStatusResponseDto properties must be documented',
  );
  assert.deepEqual(object(ownerOnboardingStatus.state, 'owner onboarding state must be documented').enum, [
    'not_started',
    'invited',
    'setup_started',
    'completed',
    'expired',
    'retired',
    'delivery_failed',
  ]);
  assert.deepEqual(
    object(
      schemas.VendorOwnerOnboardingStatusResponseDto,
      'VendorOwnerOnboardingStatusResponseDto must be documented',
    ).required,
    ['vendorId', 'state'],
  );

  const ownerStatusResponses = object(
    object(
      object(paths['/v1/platform/vendors/{vendorId}/owners/initial'], 'owner onboarding path must exist').get,
      'owner onboarding GET must exist',
    ).responses,
    'owner onboarding GET responses must be documented',
  );
  const ownerStatusSchema = responseSchema(
    ownerStatusResponses['200'],
    'owner onboarding GET success response',
  );
  assert.equal(ownerStatusSchema.$ref, '#/components/schemas/VendorOwnerOnboardingStatusResponseDto');

  const vendorProfileResponses = object(
    object(
      object(paths['/v1/vendors/{vendorId}/profile'], 'vendor profile path must exist').get,
      'vendor profile GET must exist',
    ).responses,
    'vendor profile GET responses must be documented',
  );
  const vendorProfileSchema = responseSchema(
    vendorProfileResponses['200'],
    'vendor profile GET success response',
  );
  assert.equal(vendorProfileSchema.$ref, '#/components/schemas/VendorResponseDto');

  for (const secretProperty of ['passwordHash', 'codeHash', 'refreshTokenHash', 'encryptedSecret', 'setupTokenHash', 'completionTokenHash', 'totpSecretEncrypted']) {
    for (const schema of Object.values(schemas)) {
      assert(!(secretProperty in object(schema, 'OpenAPI schema must be an object')), `OpenAPI must not expose ${secretProperty}`);
    }
  }
});
