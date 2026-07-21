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
  '/v1/platform/users': ['get'],
  '/v1/platform/users/{id}': ['delete', 'get'],
  '/v1/platform/users/{id}/deactivate': ['post'],
  '/v1/platform/users/{id}/restore': ['post'],
  '/v1/platform/vendors': ['get', 'post'],
  '/v1/platform/vendors/{id}': ['get'],
  '/v1/platform/vendors/{id}/transitions': ['post'],
  '/v1/platform/vendors/{vendorId}/owners/initial': ['get', 'post'],
  '/v1/platform/vendors/{vendorId}/owners/enrollments/{enrollmentId}/retry': ['post'],
  '/v1/vendors/{vendorId}/audit-events': ['get'],
  '/v1/vendors/{vendorId}/memberships': ['get', 'post'],
  '/v1/vendors/{vendorId}/memberships/onboard': ['post'],
  '/v1/vendors/{vendorId}/memberships/{id}': ['delete', 'get', 'patch'],
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
  'post /v1/vendors/{vendorId}/memberships/onboard',
  'delete /v1/vendors/{vendorId}/memberships/{id}',
  'patch /v1/vendors/{vendorId}/memberships/{id}',
  'post /v1/vendors/{vendorId}/memberships/{id}/end',
  'post /v1/vendors/{vendorId}/memberships/{id}/restore',
]);

const protectedOperations = new Set([
  'post /v1/auth/logout',
  'post /v1/auth/logout-all',
  'get /v1/auth/me',
  'get /v1/platform/users',
  'delete /v1/platform/users/{id}',
  'get /v1/platform/users/{id}',
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
  'post /v1/vendors/{vendorId}/memberships/onboard',
  'delete /v1/vendors/{vendorId}/memberships/{id}',
  'get /v1/vendors/{vendorId}/memberships/{id}',
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

void test('publishes the vendor-scoped member onboarding and enriched directory contract', async () => {
  const { document } = await readDocument();
  const paths = object(document.paths, 'OpenAPI paths must be documented');
  const operation = object(
    object(paths['/v1/vendors/{vendorId}/memberships/onboard'], 'onboarding path').post,
    'onboarding operation',
  );
  assert.deepEqual(operation.security, [{ opaqueBearer: [] }]);
  const responses = object(operation.responses, 'onboarding responses');
  const unavailable = object(responses['503'], 'onboarding audit-unavailable response');
  assert.match(String(unavailable.description), /SECURITY_AUDIT_UNAVAILABLE/u);
  assert.deepEqual(
    responseSchema(unavailable, 'onboarding audit-unavailable response'),
    { $ref: '#/components/schemas/ApiErrorResponseDto' },
  );

  const schemas = object(
    object(object(document.components, 'components').schemas, 'schemas'),
    'schemas',
  );
  const request = object(schemas.OnboardMembershipRequestDto, 'onboarding request');
  assert.deepEqual(request.required, ['displayName', 'phone', 'role']);
  const requestProperties = object(request.properties, 'onboarding request properties');
  assert.deepEqual(object(requestProperties.role, 'onboarding role').enum, ['customer', 'delivery_agent']);
  assert.equal(object(requestProperties.phone, 'onboarding phone').pattern, '^\\+[1-9]\\d{7,14}$');

  const directory = object(schemas.MembershipDirectoryResponseDto, 'directory response');
  assert.ok((directory.required as unknown[]).includes('displayName'));
  const serialized = JSON.stringify(operation);
  assert.doesNotMatch(serialized, /matchedExistingUser|otp|challengeToken|accessToken|refreshToken/u);
});

void test('publishes the complete Phase 1 HTTP contract without persistence secrets', async () => {
  const { document, serialized } = await readDocument();
  const paths = object(document.paths, 'OpenAPI paths must be documented');
  const householdPaths = [
    '/v1/vendors/{vendorId}/households',
    '/v1/vendors/{vendorId}/households/{id}',
    '/v1/vendors/{vendorId}/households/{id}/members',
    '/v1/vendors/{vendorId}/households/{id}/members/{memberId}/end',
    '/v1/vendors/{vendorId}/households/{id}/restore',
    '/v1/customer/vendors/{vendorId}/households',
  ];
  const catalogPaths = [
    '/v1/vendors/{vendorId}/units',
    '/v1/vendors/{vendorId}/units/{unitId}',
    '/v1/vendors/{vendorId}/units/{unitId}/deactivate',
    '/v1/vendors/{vendorId}/units/{unitId}/reactivate',
    '/v1/vendors/{vendorId}/products',
    '/v1/vendors/{vendorId}/products/{productId}',
    '/v1/vendors/{vendorId}/products/{productId}/restore',
    '/v1/vendors/{vendorId}/delivery-slots',
    '/v1/vendors/{vendorId}/delivery-slots/{slotId}',
    '/v1/vendors/{vendorId}/delivery-slots/{slotId}/deactivate',
    '/v1/vendors/{vendorId}/delivery-slots/{slotId}/reactivate',
  ];
  const pricingPaths = [
    '/v1/vendors/{vendorId}/global-prices',
    '/v1/vendors/{vendorId}/global-prices/{priceId}',
    '/v1/vendors/{vendorId}/global-prices/{priceId}/close',
    '/v1/vendors/{vendorId}/households/{householdId}/price-overrides',
    '/v1/vendors/{vendorId}/households/{householdId}/price-overrides/{overrideId}',
    '/v1/vendors/{vendorId}/households/{householdId}/price-overrides/{overrideId}/close',
    '/v1/vendors/{vendorId}/prices/resolved',
    '/v1/customer/vendors/{vendorId}/households/{householdId}/prices/resolved',
  ];
  const subscriptionPaths = [
    '/v1/vendors/{vendorId}/subscriptions',
    '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}',
    '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/revisions',
    '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/modify',
    '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/pause',
    '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/resume',
    '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/cancel',
    '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/restore',
    '/v1/customer/vendors/{vendorId}/households/{householdId}/subscriptions',
    '/v1/customer/vendors/{vendorId}/households/{householdId}/subscriptions/{subscriptionId}',
    '/v1/customer/vendors/{vendorId}/households/{householdId}/subscriptions/{subscriptionId}/revisions',
  ];
  const routePaths = ['/v1/vendors/{vendorId}/routes','/v1/vendors/{vendorId}/routes/{routeId}','/v1/vendors/{vendorId}/routes/{routeId}/deactivate','/v1/vendors/{vendorId}/routes/{routeId}/reactivate','/v1/vendors/{vendorId}/routes/{routeId}/restore','/v1/vendors/{vendorId}/routes/{routeId}/stops','/v1/vendors/{vendorId}/routes/{routeId}/stops/replace','/v1/vendors/{vendorId}/routes/{routeId}/assignments','/v1/vendors/{vendorId}/routes/{routeId}/assignments/{serviceDate}','/v1/vendors/{vendorId}/routes/{routeId}/assignments/{serviceDate}/cancel','/v1/agent/vendors/{vendorId}/route-assignments','/v1/agent/vendors/{vendorId}/scheduled-deliveries'];
  const scheduleRunPaths = ['/v1/vendors/{vendorId}/schedule-generation-runs', '/v1/vendors/{vendorId}/schedule-generation-runs/manual'];
  for (const path of householdPaths) assert.ok(paths[path], `missing ${path}`);
  for (const path of catalogPaths) assert.ok(paths[path], `missing ${path}`);
  for (const path of pricingPaths) assert.ok(paths[path], `missing ${path}`);
  for (const path of subscriptionPaths) assert.ok(paths[path], `missing ${path}`);
  for (const path of routePaths) assert.ok(paths[path], `missing ${path}`);
  for (const path of scheduleRunPaths) assert.ok(paths[path], `missing ${path}`);
  assert.deepEqual(Object.keys(paths).sort(), [...Object.keys(phaseOneOperations), ...householdPaths, ...catalogPaths, ...pricingPaths, ...subscriptionPaths, ...routePaths, ...scheduleRunPaths].sort());

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

  const membershipList = object(
    object(paths['/v1/vendors/{vendorId}/memberships'], 'membership list path must exist').get,
    'membership list operation must exist',
  );
  const membershipSearch = (membershipList.parameters as JsonObject[]).find(
    (parameter) => parameter.name === 'search',
  );
  assert.equal(
    membershipSearch?.description,
    'Searches at most 100 membership candidates per request; a sparse or empty result page can include nextCursor.',
  );

  const components = object(document.components, 'OpenAPI components must be documented');
  const securitySchemes = object(components.securitySchemes, 'security schemes must be documented');
  assert(securitySchemes.opaqueBearer);
  assert(securitySchemes.refreshCookie);
  assert.deepEqual(
    object(object(paths['/v1/auth/refresh'], 'refresh path must exist').post, 'refresh operation must exist').security,
    [{ refreshCookie: [] }, {}],
  );
  const membershipSchemas = object(components.schemas, 'OpenAPI schemas must be documented');
  const membershipPage = object(membershipSchemas.MembershipPageResponseDto, 'membership page schema');
  const membershipPageProperties = object(membershipPage.properties, 'membership page properties');
  assert.equal(
    object(membershipPageProperties.nextCursor, 'membership next cursor').description,
    'Continue when present, including after a sparse or empty search result page.',
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
  for (const forbidden of [
    'passwordHash',
    'codeHash',
    'refreshTokenHash',
    'encryptedSecret',
    'setupTokenHash',
    'completionTokenHash',
    'totpSecretEncrypted',
    'Prisma',
  ]) {
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

  const ownerStatusOperation = object(
    object(paths['/v1/platform/vendors/{vendorId}/owners/initial'], 'owner onboarding path must exist').get,
    'owner onboarding GET must exist',
  );
  assert.equal(ownerStatusOperation.requestBody, undefined, 'owner onboarding GET must not document a request body');
  const ownerStatusResponses = object(
    ownerStatusOperation.responses,
    'owner onboarding GET responses must be documented',
  );
  const ownerStatusSchema = responseSchema(
    ownerStatusResponses['200'],
    'owner onboarding GET success response',
  );
  assert.equal(ownerStatusSchema.$ref, '#/components/schemas/VendorOwnerOnboardingStatusResponseDto');

  const vendorProfileOperation = object(
    object(paths['/v1/vendors/{vendorId}/profile'], 'vendor profile path must exist').get,
    'vendor profile GET must exist',
  );
  assert.equal(vendorProfileOperation.requestBody, undefined, 'vendor profile GET must not document a request body');
  const vendorProfileResponses = object(
    vendorProfileOperation.responses,
    'vendor profile GET responses must be documented',
  );
  const vendorProfileSchema = responseSchema(
    vendorProfileResponses['200'],
    'vendor profile GET success response',
  );
  assert.equal(vendorProfileSchema.$ref, '#/components/schemas/VendorResponseDto');
  const vendorProfileUnavailableSchema = responseSchema(
    vendorProfileResponses['503'],
    'vendor profile GET audit-unavailable response',
  );
  assert.equal(vendorProfileUnavailableSchema.$ref, '#/components/schemas/ApiErrorResponseDto');

  for (const [name, responses] of [
    ['owner onboarding GET', ownerStatusResponses],
    ['vendor profile GET', vendorProfileResponses],
  ] as const) {
    for (const [status, response] of Object.entries(responses)) {
      if (/^[45]/.test(status)) {
        assert.equal(
          responseSchema(response, `${name} ${status} response`).$ref,
          '#/components/schemas/ApiErrorResponseDto',
        );
      }
    }
  }
});

void test('publishes the additive effective-pricing contract without leaking customer source IDs', async () => {
  const { document } = await readDocument();
  const paths = object(document.paths, 'OpenAPI paths must be documented');
  const operations = [
    ['get', '/v1/vendors/{vendorId}/global-prices', '200', 'PriceListResponseDto'],
    ['post', '/v1/vendors/{vendorId}/global-prices', '201', 'PriceResponseDto'],
    ['get', '/v1/vendors/{vendorId}/global-prices/{priceId}', '200', 'PriceResponseDto'],
    ['post', '/v1/vendors/{vendorId}/global-prices/{priceId}/close', '200', 'PriceResponseDto'],
    ['get', '/v1/vendors/{vendorId}/households/{householdId}/price-overrides', '200', 'OverrideListResponseDto'],
    ['post', '/v1/vendors/{vendorId}/households/{householdId}/price-overrides', '201', 'OverrideResponseDto'],
    ['get', '/v1/vendors/{vendorId}/households/{householdId}/price-overrides/{overrideId}', '200', 'OverrideResponseDto'],
    ['post', '/v1/vendors/{vendorId}/households/{householdId}/price-overrides/{overrideId}/close', '200', 'OverrideResponseDto'],
    ['get', '/v1/vendors/{vendorId}/prices/resolved', '200', 'ResolvedPriceResponseDto'],
    ['get', '/v1/customer/vendors/{vendorId}/households/{householdId}/prices/resolved', '200', 'CustomerResolvedPriceResponseDto'],
  ] as const;
  for (const [method, path, status, schemaName] of operations) {
    const operation = object(object(paths[path], `missing ${path}`)[method], `missing ${method.toUpperCase()} ${path}`);
    assert.deepEqual(operation.security, [{ opaqueBearer: [] }]);
    assert.equal(responseSchema(object(object(operation.responses, `${path} responses`)['409'], `${path} 409`), `${path} 409 response`).$ref, '#/components/schemas/ApiErrorResponseDto');
    assert.equal(responseSchema(object(object(operation.responses, `${path} responses`)['503'], `${path} 503`), `${path} 503 response`).$ref, '#/components/schemas/ApiErrorResponseDto');
    assert.equal(responseSchema(object(object(operation.responses, `${path} responses`)[status], `${path} ${status}`), `${path} response`).$ref, `#/components/schemas/${schemaName}`);
  }
  const schemas = object(object(document.components, 'components').schemas, 'schemas');
  const properties = (name: string) => object(object(schemas[name], name).properties, `${name} properties`);
  assert.deepEqual(Object.keys(properties('PriceResponseDto')).sort(), ['amountMinor', 'createdAt', 'currency', 'effectiveFrom', 'effectiveTo', 'id', 'productId', 'unitId', 'updatedAt', 'vendorId']);
  assert.equal(object(properties('PriceResponseDto').amountMinor, 'price amount').type, 'string');
  assert.equal(object(properties('PriceResponseDto').effectiveTo, 'price end').nullable, true);
  assert.ok('sourcePriceId' in properties('ResolvedPriceResponseDto'));
  assert.equal('sourcePriceId' in properties('CustomerResolvedPriceResponseDto'), false);
  assert.equal('currency' in properties('CreatePriceRequestDto'), false);
  for (const path of ['/v1/vendors/{vendorId}/global-prices', '/v1/vendors/{vendorId}/households/{householdId}/price-overrides']) {
    const parameters = object(paths[path], path).get as JsonObject;
    const names = (parameters.parameters as JsonObject[]).map(({ name }) => name);
    for (const name of ['cursor', 'limit', 'productId', 'unitId']) assert.ok(names.includes(name));
  }
});

void test('publishes the effective-dated subscription contract with customer-safe schemas', async () => {
  const { document } = await readDocument(); const paths = object(document.paths, 'OpenAPI paths');
  const operations = [
    ['get', '/v1/vendors/{vendorId}/subscriptions', '200', 'SubscriptionListResponseDto', undefined],
    ['post', '/v1/vendors/{vendorId}/subscriptions', '201', 'SubscriptionResponseDto', 'CreateSubscriptionRequestDto'],
    ['get', '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}', '200', 'SubscriptionResponseDto', undefined],
    ['delete', '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}', '204', undefined, 'SubscriptionVersionReasonRequestDto'],
    ['get', '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/revisions', '200', 'SubscriptionHistoryResponseDto', undefined],
    ['post', '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/modify', '200', 'SubscriptionResponseDto', 'ModifySubscriptionRequestDto'],
    ['post', '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/pause', '200', 'SubscriptionResponseDto', 'SubscriptionTransitionRequestDto'],
    ['post', '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/resume', '200', 'SubscriptionResponseDto', 'SubscriptionTransitionRequestDto'],
    ['post', '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/cancel', '200', 'SubscriptionResponseDto', 'SubscriptionTransitionRequestDto'],
    ['post', '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}/restore', '200', 'SubscriptionResponseDto', 'SubscriptionVersionReasonRequestDto'],
    ['get', '/v1/customer/vendors/{vendorId}/households/{householdId}/subscriptions', '200', 'CustomerSubscriptionListResponseDto', undefined],
    ['get', '/v1/customer/vendors/{vendorId}/households/{householdId}/subscriptions/{subscriptionId}', '200', 'CustomerSubscriptionResponseDto', undefined],
    ['get', '/v1/customer/vendors/{vendorId}/households/{householdId}/subscriptions/{subscriptionId}/revisions', '200', 'CustomerSubscriptionHistoryResponseDto', undefined],
  ] as const;
  for (const [method, path, status, responseName, bodyName] of operations) {
    const operation = object(object(paths[path], `missing ${path}`)[method], `missing ${method} ${path}`);
    assert.deepEqual(operation.security, [{ opaqueBearer: [] }]);
    const responses = object(operation.responses, `${path} responses`);
    if (responseName) assert.equal(responseSchema(responses[status], `${path} ${status}`).$ref, `#/components/schemas/${responseName}`);
    else assert.equal(object(responses[status], `${path} ${status}`).content, undefined);
    for (const errorStatus of ['400', '401', '403', '404', '409', '503'])
      assert.equal(responseSchema(responses[errorStatus], `${path} ${errorStatus}`).$ref, '#/components/schemas/ApiErrorResponseDto');
    if (bodyName) {
      const request = object(operation.requestBody, `${path} request body`); const content = object(request.content, `${path} content`);
      assert.equal(object(object(content['application/json'], `${path} JSON`).schema, `${path} schema`).$ref, `#/components/schemas/${bodyName}`);
    }
  }
  const schemas = object(object(document.components, 'components').schemas, 'schemas');
  const properties = (name: string) => object(object(schemas[name], name).properties, `${name} properties`);
  assert.equal(object(properties('CreateSubscriptionRequestDto').quantity, 'quantity').type, 'string');
  assert.equal(object(properties('CreateSubscriptionRequestDto').startDate, 'start date').format, 'date');
  for (const name of ['SubscriptionRevisionResponseDto', 'CustomerSubscriptionRevisionResponseDto']) {
    const revision = properties(name);
    assert.equal(object(revision.startDate, `${name} start date`).format, 'date');
    assert.equal(object(revision.endDate, `${name} end date`).format, 'date');
    assert.equal('effectiveFrom' in revision, false);
    assert.equal('effectiveTo' in revision, false);
  }
  assert.ok('createdBy' in properties('SubscriptionRevisionResponseDto'));
  assert.ok('supersessionReason' in properties('SubscriptionRevisionResponseDto'));
  assert.equal('createdBy' in properties('CustomerSubscriptionRevisionResponseDto'), false);
  assert.equal('supersessionReason' in properties('CustomerSubscriptionRevisionResponseDto'), false);
  const customerList = object(object(paths['/v1/customer/vendors/{vendorId}/households/{householdId}/subscriptions'], 'customer subscriptions').get, 'customer subscriptions get');
  const customerParameters = customerList.parameters as JsonObject[];
  assert.equal(customerParameters.some(({ name, in: location }) => name === 'householdId' && location === 'query'), false);
  const vendorList = object(object(paths['/v1/vendors/{vendorId}/subscriptions'], 'vendor subscriptions').get, 'vendor subscriptions get');
  const vendorParameters = vendorList.parameters as JsonObject[];
  assert.deepEqual(vendorParameters.map(({ name }) => name).sort(), [
    'cursor', 'deliverySlotId', 'householdId', 'lifecycle', 'limit', 'productId', 'routeId', 'routeServiceDate', 'status', 'vendorId',
  ]);
  assert.equal(object(object(vendorParameters.find(({ name }) => name === 'routeId'), 'routeId parameter').schema, 'routeId schema').format, 'uuid');
  assert.equal(object(object(vendorParameters.find(({ name }) => name === 'routeServiceDate'), 'routeServiceDate parameter').schema, 'routeServiceDate schema').format, 'date');
});

void test('publishes secured explicit route-definition contracts', async () => {
  const { document } = await readDocument(); const paths = object(document.paths, 'paths');
  const operations = [
    ['get','/v1/vendors/{vendorId}/routes','200','RouteListResponseDto',undefined],
    ['post','/v1/vendors/{vendorId}/routes','201','RouteResponseDto','CreateRouteRequestDto'],
    ['get','/v1/vendors/{vendorId}/routes/{routeId}','200','RouteResponseDto',undefined],
    ['patch','/v1/vendors/{vendorId}/routes/{routeId}','200','RouteResponseDto','RenameRouteRequestDto'],
    ['delete','/v1/vendors/{vendorId}/routes/{routeId}','204',undefined,'RouteVersionReasonRequestDto'],
    ['post','/v1/vendors/{vendorId}/routes/{routeId}/deactivate','200','RouteResponseDto','RouteVersionReasonRequestDto'],
    ['post','/v1/vendors/{vendorId}/routes/{routeId}/reactivate','200','RouteResponseDto','RouteVersionReasonRequestDto'],
    ['post','/v1/vendors/{vendorId}/routes/{routeId}/restore','200','RouteResponseDto','RouteVersionReasonRequestDto'],
  ] as const;
  for (const [method,path,status,responseName,bodyName] of operations) {
    const operation = object(object(paths[path], path)[method], `${method} ${path}`); assert.deepEqual(operation.security, [{ opaqueBearer: [] }]); const responses = object(operation.responses, 'responses');
    if (responseName) assert.equal(responseSchema(responses[status], `${path} ${status}`).$ref, `#/components/schemas/${responseName}`); else assert.equal(object(responses[status], 'response').content, undefined);
    for (const errorStatus of ['400','401','403','404','409','503']) assert.equal(responseSchema(responses[errorStatus], `${path} ${errorStatus}`).$ref, '#/components/schemas/ApiErrorResponseDto');
    if (bodyName) { const content = object(object(operation.requestBody, 'body').content, 'content'); assert.equal(object(object(content['application/json'], 'json').schema, 'schema').$ref, `#/components/schemas/${bodyName}`); }
  }
});

void test('publishes secured route stop projection and atomic replacement contracts', async () => {
  const { document } = await readDocument(); const paths = object(document.paths, 'paths');
  const schemas = object(object(document.components, 'components').schemas, 'schemas');
  const properties = (name: string) => object(object(schemas[name], name).properties, `${name} properties`);
  const path = '/v1/vendors/{vendorId}/routes/{routeId}/stops'; const item = object(paths[path], path);
  const replacements = '/v1/vendors/{vendorId}/routes/{routeId}/stops/replace';
  assert.equal(item.post,undefined);
  for (const [operationPath,method, body] of [[path,'get', undefined], [replacements,'post', 'ReplaceRouteStopsRequestDto']] as const) {
    const operation = object(object(paths[operationPath],operationPath)[method], `${method} ${operationPath}`); assert.deepEqual(operation.security, [{ opaqueBearer: [] }]);
    assert.equal(responseSchema(object(operation.responses, 'responses')['200'], '200').$ref, '#/components/schemas/RouteStopsResponseDto');
    if (body) { const content = object(object(operation.requestBody, 'body').content, 'content'); assert.equal(object(object(content['application/json'], 'json').schema, 'schema').$ref, `#/components/schemas/${body}`); }
  }
  const getParameters=object(paths[path],path).get as JsonObject;const names=(getParameters.parameters as JsonObject[]).map(({name})=>name).sort();assert.deepEqual(names,['cursor','limit','routeId','serviceDate','vendorId']);
  assert.equal(object(properties('ReplaceRouteStopsRequestDto').householdIds,'householdIds').maxItems,undefined);
  assert.deepEqual(Object.keys(properties('RouteStopResponseDto')).sort(), ['household','householdId','id','sequence']);
  assert.equal(object(properties('RouteStopResponseDto').household,'household').$ref,'#/components/schemas/RouteStopHouseholdResponseDto');
  assert.deepEqual(Object.keys(properties('RouteStopHouseholdResponseDto')).sort(), ['accountNumber','addressLine1','addressLine2','city','countryCode','id','latitude','locality','longitude','name','postalCode','region','status']);
  assert.deepEqual((object(schemas.RouteStopResponseDto,'RouteStopResponseDto').required as string[]).sort(), ['household','householdId','id','sequence']);
  assert.deepEqual((object(schemas.RouteStopHouseholdResponseDto,'RouteStopHouseholdResponseDto').required as string[]).sort(), ['accountNumber','addressLine1','city','countryCode','id','name','postalCode','region','status']);
  assert.deepEqual(Object.keys(properties('RouteStopsResponseDto')).sort(), ['deliverySlotId','endDate','nextCursor','routeId','routeVersion','serviceDate','startDate','stops']);
});

void test('publishes exact-date vendor and agent-self assignment contracts', async()=>{
  const {document}=await readDocument();const paths=object(document.paths,'paths');
  const list='/v1/vendors/{vendorId}/routes/{routeId}/assignments',item='/v1/vendors/{vendorId}/routes/{routeId}/assignments/{serviceDate}',cancel=`${item}/cancel`,self='/v1/agent/vendors/{vendorId}/route-assignments';
  assert.deepEqual(Object.keys(object(paths[list],list)),['get']);assert.deepEqual(Object.keys(object(paths[item],item)),['put']);assert.deepEqual(Object.keys(object(paths[cancel],cancel)),['post']);assert.deepEqual(Object.keys(object(paths[self],self)),['get']);
  const put=object(object(paths[item],item).put,'put');const responses=object(put.responses,'responses');
  assert.equal(responseSchema(responses['200'],'200').$ref,'#/components/schemas/RouteAssignmentMutationResponseDto');assert.equal(responseSchema(responses['201'],'201').$ref,'#/components/schemas/RouteAssignmentMutationResponseDto');
  for(const path of[list,self]){const get=object(object(paths[path],path).get,'get');const limit=(get.parameters as JsonObject[]).find(({name})=>name==='limit');assert(limit);assert.deepEqual(object(limit.schema,'limit schema'),{minimum:1,maximum:100,default:25,type:'number'});}
});

void test('publishes the additive vendor catalog contract', async () => {
  const { document } = await readDocument();
  const paths = object(document.paths, 'OpenAPI paths must be documented');
  const operations = [
    ['get', '/v1/vendors/{vendorId}/units', '200', 'UnitListResponseDto'],
    ['post', '/v1/vendors/{vendorId}/units', '201', 'UnitResponseDto'],
    ['get', '/v1/vendors/{vendorId}/units/{unitId}', '200', 'UnitResponseDto'],
    ['patch', '/v1/vendors/{vendorId}/units/{unitId}', '200', 'UnitResponseDto'],
    ['post', '/v1/vendors/{vendorId}/units/{unitId}/deactivate', '200', 'UnitResponseDto'],
    ['post', '/v1/vendors/{vendorId}/units/{unitId}/reactivate', '200', 'UnitResponseDto'],
    ['get', '/v1/vendors/{vendorId}/products', '200', 'ProductListResponseDto'],
    ['post', '/v1/vendors/{vendorId}/products', '201', 'ProductResponseDto'],
    ['get', '/v1/vendors/{vendorId}/products/{productId}', '200', 'ProductResponseDto'],
    ['patch', '/v1/vendors/{vendorId}/products/{productId}', '200', 'ProductResponseDto'],
    ['delete', '/v1/vendors/{vendorId}/products/{productId}', '204', undefined],
    ['post', '/v1/vendors/{vendorId}/products/{productId}/restore', '200', 'ProductResponseDto'],
    ['get', '/v1/vendors/{vendorId}/delivery-slots', '200', 'DeliverySlotListResponseDto'],
    ['post', '/v1/vendors/{vendorId}/delivery-slots', '201', 'DeliverySlotResponseDto'],
    ['get', '/v1/vendors/{vendorId}/delivery-slots/{slotId}', '200', 'DeliverySlotResponseDto'],
    ['patch', '/v1/vendors/{vendorId}/delivery-slots/{slotId}', '200', 'DeliverySlotResponseDto'],
    ['post', '/v1/vendors/{vendorId}/delivery-slots/{slotId}/deactivate', '200', 'DeliverySlotResponseDto'],
    ['post', '/v1/vendors/{vendorId}/delivery-slots/{slotId}/reactivate', '200', 'DeliverySlotResponseDto'],
  ] as const;
  for (const [method, path, status, schemaName] of operations) {
    const operation = object(object(paths[path], `missing ${path}`)[method], `missing ${method.toUpperCase()} ${path}`);
    assert.deepEqual(operation.security, [{ opaqueBearer: [] }]);
    const response = object(object(operation.responses, `${path} responses`)[status], `${path} ${status}`);
    if (schemaName) assert.equal(responseSchema(response, `${path} response`).$ref, `#/components/schemas/${schemaName}`);
    else assert.equal(response.content, undefined);
  }
  for (const [method, path, schemaName] of [
    ['post', '/v1/vendors/{vendorId}/delivery-slots', 'CreateDeliverySlotRequestDto'],
    ['patch', '/v1/vendors/{vendorId}/delivery-slots/{slotId}', 'RenameDeliverySlotRequestDto'],
    ['post', '/v1/vendors/{vendorId}/delivery-slots/{slotId}/deactivate', 'ReasonRequestDto'],
    ['post', '/v1/vendors/{vendorId}/delivery-slots/{slotId}/reactivate', 'ReasonRequestDto'],
  ] as const) {
    const operation = object(object(paths[path], path)[method], `${method} ${path}`);
    const requestBody = object(operation.requestBody, `${method} ${path} request body`);
    const content = object(requestBody.content, `${method} ${path} request content`);
    assert.equal(object(object(content['application/json'], 'JSON request').schema, 'request schema').$ref, `#/components/schemas/${schemaName}`);
  }
  for (const path of ['/v1/vendors/{vendorId}/units', '/v1/vendors/{vendorId}/products', '/v1/vendors/{vendorId}/delivery-slots']) {
    const parameters = object(paths[path], path).get as JsonObject;
    const names = (parameters.parameters as JsonObject[]).map(({ name }) => name);
    for (const name of ['cursor', 'limit', 'status', 'search']) assert.ok(names.includes(name));
    assert.equal(names.includes('lifecycle'), path.endsWith('/products'));
  }
  const schemas = object(object(document.components, 'components').schemas, 'schemas');
  const properties = (name: string) => object(object(schemas[name], name).properties, `${name} properties`);
  assert.deepEqual(Object.keys(properties('UnitResponseDto')).sort(), ['code', 'createdAt', 'decimalScale', 'id', 'name', 'status', 'updatedAt', 'vendorId']);
  assert.deepEqual(Object.keys(properties('ProductResponseDto')).sort(), ['code', 'createdAt', 'defaultUnitId', 'id', 'lifecycle', 'name', 'status', 'updatedAt', 'vendorId', 'version']);
  assert.deepEqual(Object.keys(properties('DeliverySlotResponseDto')).sort(), ['code', 'createdAt', 'endLocalTime', 'id', 'name', 'startLocalTime', 'status', 'updatedAt', 'vendorId']);
  assert.equal('expectedVersion' in properties('CreateProductRequestDto'), false);
  assert.equal(object(properties('CreateUnitRequestDto').code, 'unit code').pattern, '^[A-Za-z0-9_-]{2,32}$');
  assert.equal(object(properties('CreateProductRequestDto').code, 'product code').pattern, '^[A-Za-z0-9_-]{2,32}$');
  assert.equal(object(properties('CreateDeliverySlotRequestDto').code, 'delivery-slot code').pattern, '^[A-Za-z0-9_-]{2,32}$');
  for (const name of ['startLocalTime', 'endLocalTime']) {
    assert.equal(object(properties('CreateDeliverySlotRequestDto')[name], `${name} schema`).pattern, '^(?:[01]\\d|2[0-3]):[0-5]\\d$');
    assert.equal(object(properties('DeliverySlotResponseDto')[name], `${name} response schema`).pattern, '^(?:[01]\\d|2[0-3]):[0-5]\\d$');
  }
  assert.deepEqual(Object.keys(properties('RenameDeliverySlotRequestDto')), ['name']);
  assert.deepEqual(object(schemas.RestoreProductRequestDto, 'restore product DTO').required, ['expectedVersion']);
  assert.deepEqual(object(properties('ProductResponseDto').status, 'product status').enum, ['active', 'inactive']);
});

void test('publishes secured manual schedule generation and run visibility contracts', async () => {
  const { document } = await readDocument();
  const paths = object(document.paths, 'paths');
  const runsPath = '/v1/vendors/{vendorId}/schedule-generation-runs';
  const manualPath = `${runsPath}/manual`;
  assert.deepEqual(Object.keys(object(paths[runsPath], runsPath)), ['get']);
  assert.deepEqual(Object.keys(object(paths[manualPath], manualPath)), ['post']);

  const list = object(object(paths[runsPath], runsPath).get, 'run list');
  const manual = object(object(paths[manualPath], manualPath).post, 'manual generation');
  for (const operation of [list, manual]) {
    assert.deepEqual(operation.security, [{ opaqueBearer: [] }]);
    const responses = object(operation.responses, 'schedule generation responses');
    for (const status of ['400', '401', '403', '404', '409', '503']) {
      assert.equal(
        responseSchema(responses[status], `schedule generation ${status}`).$ref,
        '#/components/schemas/ApiErrorResponseDto',
      );
    }
  }
  assert.equal(
    responseSchema(object(list.responses, 'list responses')['200'], 'list 200').$ref,
    '#/components/schemas/ScheduleGenerationRunListResponseDto',
  );
  assert.equal(
    responseSchema(object(manual.responses, 'manual responses')['200'], 'manual 200').$ref,
    '#/components/schemas/ScheduleGenerationRunResponseDto',
  );
  const requestContent = object(object(manual.requestBody, 'manual body').content, 'manual content');
  assert.equal(
    object(object(requestContent['application/json'], 'manual JSON').schema, 'manual schema').$ref,
    '#/components/schemas/GenerateManualScheduleRunRequestDto',
  );
  const parameters = list.parameters as JsonObject[];
  assert.deepEqual(
    parameters.map(({ name }) => name).sort(),
    ['cursor', 'limit', 'serviceDate', 'status', 'trigger', 'vendorId'],
  );
  const limit = parameters.find(({ name }) => name === 'limit');
  assert(limit);
  assert.deepEqual(object(limit.schema, 'run list limit schema'), {
    minimum: 1,
    maximum: 100,
    default: 25,
    type: 'number',
  });

  const schemas = object(object(document.components, 'components').schemas, 'schemas');
  const properties = object(
    object(schemas.ScheduleGenerationRunResponseDto, 'run response').properties,
    'run response properties',
  );
  assert.equal('vendorId' in properties, false);
  assert.equal('leaseToken' in properties, false);
  assert.equal('requestedByUserId' in properties, false);
  assert.equal(object(properties.serviceDate, 'service date').format, 'date');
  assert.equal(object(properties.attempt, 'attempt').minimum, 0);
  assert.equal(object(properties.failureMessage, 'failure message').type, 'string');
});

void test('publishes the safe agent scheduled-delivery projection', async () => {
  const { document } = await readDocument();
  const paths = object(document.paths, 'paths');
  const operation = object(object(paths['/v1/agent/vendors/{vendorId}/scheduled-deliveries'], 'scheduled path').get, 'scheduled get');
  const schemas = object(object(document.components, 'components').schemas, 'schemas');
  const properties = (name: string) => object(object(schemas[name], name).properties, `${name} properties`);
  assert.deepEqual((operation.parameters as JsonObject[]).map(({ name }) => name).sort(), ['cursor', 'limit', 'serviceDate', 'vendorId']);
  assert.deepEqual(Object.keys(properties('ScheduledDeliveryListResponseDto')).sort(), ['items', 'nextCursor']);
  assert.deepEqual(Object.keys(properties('ScheduledDeliveryResponseDto')).sort(), [
    'deliverySlotId', 'householdId', 'id', 'plannedQuantity', 'productId', 'routeAssignmentId',
    'routeStopId', 'sequence', 'serviceDate', 'subscriptionId', 'unitId',
  ]);
});

void test('publishes the complete additive household contract', async () => {
  const { document } = await readDocument();
  const paths = object(document.paths, 'OpenAPI paths must be documented');
  const operations = [
    {
      method: 'get',
      path: '/v1/vendors/{vendorId}/households',
      success: '200',
      response: 'HouseholdListResponseDto',
      query: true,
    },
    {
      method: 'post',
      path: '/v1/vendors/{vendorId}/households',
      success: '201',
      response: 'HouseholdResponseDto',
      body: 'CreateHouseholdRequestDto',
    },
    {
      method: 'get',
      path: '/v1/vendors/{vendorId}/households/{id}',
      success: '200',
      response: 'HouseholdResponseDto',
    },
    {
      method: 'patch',
      path: '/v1/vendors/{vendorId}/households/{id}',
      success: '200',
      response: 'HouseholdResponseDto',
      body: 'UpdateHouseholdRequestDto',
    },
    {
      method: 'delete',
      path: '/v1/vendors/{vendorId}/households/{id}',
      success: '204',
      body: 'VersionedReasonRequestDto',
    },
    {
      method: 'post',
      path: '/v1/vendors/{vendorId}/households/{id}/restore',
      success: '200',
      response: 'HouseholdResponseDto',
      body: 'VersionedReasonRequestDto',
    },
    {
      method: 'get',
      path: '/v1/vendors/{vendorId}/households/{id}/members',
      success: '200',
      response: 'HouseholdMemberListResponseDto',
      query: true,
    },
    {
      method: 'post',
      path: '/v1/vendors/{vendorId}/households/{id}/members',
      success: '201',
      response: 'HouseholdMemberResponseDto',
      body: 'AttachHouseholdMemberRequestDto',
    },
    {
      method: 'post',
      path: '/v1/vendors/{vendorId}/households/{id}/members/{memberId}/end',
      success: '200',
      response: 'HouseholdMemberResponseDto',
      body: 'EndHouseholdMemberRequestDto',
    },
    {
      method: 'get',
      path: '/v1/customer/vendors/{vendorId}/households',
      success: '200',
      response: 'CustomerHouseholdListResponseDto',
      query: true,
    },
  ] as const;

  for (const expected of operations) {
    const label = `${expected.method.toUpperCase()} ${expected.path}`;
    const operation = object(
      object(paths[expected.path], `missing ${expected.path}`)[expected.method],
      `missing ${label}`,
    );
    assert.deepEqual(
      operation.security,
      [{ opaqueBearer: [] }],
      `${label} must require bearer authentication`,
    );
    const responses = object(
      operation.responses,
      `${label} must document responses`,
    );
    const success = object(
      responses[expected.success],
      `${label} must document ${expected.success}`,
    );
    if ('response' in expected) {
      assert.equal(
        responseSchema(success, `${label} success response`).$ref,
        `#/components/schemas/${expected.response}`,
      );
    } else {
      assert.equal(
        success.content,
        undefined,
        `${label} 204 must not document a response body`,
      );
    }
    for (const status of ['400', '401', '403', '404', '409', '503']) {
      assert.equal(
        responseSchema(responses[status], `${label} ${status} response`).$ref,
        '#/components/schemas/ApiErrorResponseDto',
      );
    }
    if ('body' in expected) {
      const requestBody = object(
        operation.requestBody,
        `${label} must document its request body`,
      );
      const content = object(
        requestBody.content,
        `${label} request body must have content`,
      );
      assert.equal(
        object(
          object(content['application/json'], `${label} must accept JSON`)
            .schema,
          `${label} JSON body must have a schema`,
        ).$ref,
        `#/components/schemas/${expected.body}`,
      );
    } else {
      assert.equal(
        operation.requestBody,
        undefined,
        `${label} must not document a request body`,
      );
    }
    if ('query' in expected) {
      const parameters = operation.parameters as JsonObject[];
      assert(
        Array.isArray(parameters),
        `${label} must document query parameters`,
      );
      const cursor = parameters.find(
        (parameter) => parameter.name === 'cursor',
      );
      assert.equal(object(cursor, `${label} must document cursor`).in, 'query');
      assert.equal(
        object(
          object(cursor, `${label} cursor`).schema,
          `${label} cursor schema`,
        ).type,
        'string',
      );
      const limit = parameters.find((parameter) => parameter.name === 'limit');
      const limitSchema = object(
        object(limit, `${label} must document limit`).schema,
        `${label} limit schema`,
      );
      assert.equal(limitSchema.default, 25);
      assert.equal(limitSchema.minimum, 1);
      assert.equal(limitSchema.maximum, 100);
    }
  }

  const vendorList = object(
    object(paths['/v1/vendors/{vendorId}/households'], 'vendor household list').get,
    'vendor household list operation',
  );
  const vendorParameters = vendorList.parameters as JsonObject[];
  assert.deepEqual(
    vendorParameters.map(({ name }) => name).sort(),
    ['cursor', 'lifecycle', 'limit', 'search', 'status', 'vendorId'],
  );
  const searchSchema = object(
    object(
      vendorParameters.find(({ name }) => name === 'search'),
      'vendor household list must document search',
    ).schema,
    'vendor household search schema',
  );
  assert.equal(searchSchema.type, 'string');
  assert.equal(searchSchema.minLength, 1);
  assert.equal(searchSchema.maxLength, 160);
  assert.equal(searchSchema.pattern, '\\S');
  const statusSchema = object(
    object(
      vendorParameters.find(({ name }) => name === 'status'),
      'vendor household list must document status',
    ).schema,
    'vendor household status schema',
  );
  assert.deepEqual(statusSchema.enum, ['active', 'inactive']);
  assert.equal(statusSchema.default, undefined);
  for (const path of [
    '/v1/vendors/{vendorId}/households/{id}/members',
    '/v1/customer/vendors/{vendorId}/households',
  ]) {
    const list = object(object(paths[path], path).get, `${path} GET`);
    assert.deepEqual(
      (list.parameters as JsonObject[]).map(({ name }) => name).sort(),
      path.includes('/members')
        ? ['cursor', 'id', 'limit', 'vendorId']
        : ['cursor', 'limit', 'vendorId'],
    );
  }

  const approvedMethods = new Map<string, string[]>();
  for (const { method, path } of operations) {
    approvedMethods.set(path, [...(approvedMethods.get(path) ?? []), method]);
  }
  for (const [path, methods] of approvedMethods) {
    assert.deepEqual(
      Object.keys(object(paths[path], `missing ${path}`)).sort(),
      methods.sort(),
    );
  }

  const schemas = object(
    object(document.components, 'components must exist').schemas,
    'schemas must exist',
  );
  const properties = (name: string) =>
    object(
      object(schemas[name], `${name} must be documented`).properties,
      `${name} properties must be documented`,
    );
  const vendorHousehold = properties('HouseholdResponseDto');
  const customerHousehold = properties('CustomerHouseholdResponseDto');
  const member = properties('HouseholdMemberResponseDto');
  assert.deepEqual(Object.keys(vendorHousehold).sort(), [
    'accountNumber', 'addressLine1', 'addressLine2', 'city', 'countryCode',
    'createdAt', 'id', 'latitude', 'lifecycle', 'locality', 'longitude', 'name', 'notes',
    'postalCode', 'region', 'status', 'updatedAt', 'vendorId', 'version',
  ]);
  assert.deepEqual(Object.keys(customerHousehold).sort(), [
    'accountNumber', 'addressLine1', 'addressLine2', 'city', 'countryCode',
    'createdAt', 'id', 'latitude', 'locality', 'longitude', 'name',
    'postalCode', 'region', 'status', 'updatedAt', 'vendorId', 'version',
  ]);
  assert.deepEqual(Object.keys(member).sort(), [
    'createdAt', 'customerMembershipId', 'displayName', 'endedAt',
    'householdId', 'id', 'joinedAt', 'phone', 'status', 'updatedAt', 'userId',
  ]);
  for (const field of ['id', 'vendorId']) {
    assert.equal(object(vendorHousehold[field], `vendor household ${field}`).format, 'uuid');
    assert.equal(object(customerHousehold[field], `customer household ${field}`).format, 'uuid');
  }
  for (const field of ['id', 'householdId', 'customerMembershipId', 'userId'])
    assert.equal(object(member[field], `household member ${field}`).format, 'uuid');
  for (const field of ['joinedAt', 'endedAt', 'createdAt', 'updatedAt'])
    assert.equal(object(member[field], `household member ${field}`).format, 'date-time');
  assert.deepEqual(object(vendorHousehold.status, 'vendor household status').enum, ['active', 'inactive']);
  assert.deepEqual(object(customerHousehold.status, 'customer household status').enum, ['active', 'inactive']);
  assert.deepEqual(object(member.status, 'household member status').enum, ['active', 'ended']);
  assert.deepEqual(Object.keys(properties('HouseholdListResponseDto')).sort(), [
    'items',
    'nextCursor',
  ]);
  assert.deepEqual(
    Object.keys(properties('CustomerHouseholdListResponseDto')).sort(),
    ['items', 'nextCursor'],
  );
  assert.deepEqual(
    Object.keys(properties('HouseholdMemberListResponseDto')).sort(),
    ['items', 'nextCursor'],
  );
  assert.equal(
    object(
      object(
        properties('HouseholdListResponseDto').items,
        'vendor household items',
      ).items,
      'vendor household item schema',
    ).$ref,
    '#/components/schemas/HouseholdResponseDto',
  );
  assert.equal(
    object(
      object(
        properties('CustomerHouseholdListResponseDto').items,
        'customer household items',
      ).items,
      'customer household item schema',
    ).$ref,
    '#/components/schemas/CustomerHouseholdResponseDto',
  );
  for (const schemaName of [
    'HouseholdResponseDto',
    'CustomerHouseholdResponseDto',
    'HouseholdMemberResponseDto',
  ]) {
    const fields = properties(schemaName);
    for (const forbidden of [
      'deletedAt',
      'deletedBy',
      'deletionReason',
      'vendorMembership',
      'identities',
      'passwordHash',
      'refreshTokenHash',
    ])
      assert(
        !(forbidden in fields),
        `${schemaName} must not expose ${forbidden}`,
      );
  }
});

void test('publishes the frozen restorable lifecycle OpenAPI contract', async () => {
  const { document } = await readDocument();
  const paths = object(document.paths, 'OpenAPI paths must be documented');
  const schemas = object(
    object(document.components, 'OpenAPI components must be documented').schemas,
    'OpenAPI schemas must be documented',
  );
  const lifecycleOperations = [
    ['get', '/v1/platform/users'],
    ['get', '/v1/platform/users/{id}'],
    ['get', '/v1/vendors/{vendorId}/households'],
    ['get', '/v1/vendors/{vendorId}/households/{id}'],
    ['get', '/v1/vendors/{vendorId}/memberships'],
    ['get', '/v1/vendors/{vendorId}/memberships/{id}'],
    ['get', '/v1/vendors/{vendorId}/products'],
    ['get', '/v1/vendors/{vendorId}/products/{productId}'],
    ['get', '/v1/vendors/{vendorId}/routes'],
    ['get', '/v1/vendors/{vendorId}/routes/{routeId}'],
    ['get', '/v1/vendors/{vendorId}/subscriptions'],
    ['get', '/v1/vendors/{vendorId}/subscriptions/{subscriptionId}'],
  ] as const;

  for (const [method, path] of lifecycleOperations) {
    const operation = object(
      object(paths[path], `missing lifecycle path ${path}`)[method],
      `missing ${method.toUpperCase()} ${path}`,
    );
    const parameter = (operation.parameters as JsonObject[]).find(
      ({ name }) => name === 'lifecycle',
    );
    assert(parameter, `${method.toUpperCase()} ${path} must document lifecycle`);
    assert.equal(parameter.in, 'query');
    assert.equal(parameter.required, false);
    const schema = object(parameter.schema, `${path} lifecycle schema`);
    assert.deepEqual(schema.enum, ['current', 'deleted']);
    assert.equal(schema.default, 'current');
  }

  const actualLifecycleOperations: string[] = [];
  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = object(pathValue, `${path} path item`);
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operationValue = pathItem[method];
      if (operationValue === undefined) continue;
      const operation = object(operationValue, `${method} ${path}`);
      const parameters = Array.isArray(operation.parameters)
        ? operation.parameters as JsonObject[]
        : [];
      if (parameters.some(({ name }) => name === 'lifecycle'))
        actualLifecycleOperations.push(`${method} ${path}`);
    }
  }
  assert.deepEqual(
    actualLifecycleOperations.sort(),
    lifecycleOperations.map(([method, path]) => `${method} ${path}`).sort(),
    'customer/agent, route-stop, assignment, schedule, unit, and delivery-slot routes must not expose lifecycle',
  );

  for (const path of [
    '/v1/vendors/{vendorId}/households',
    '/v1/vendors/{vendorId}/memberships',
    '/v1/vendors/{vendorId}/products',
    '/v1/vendors/{vendorId}/routes',
    '/v1/vendors/{vendorId}/subscriptions',
  ]) {
    const operation = object(object(paths[path], path).get, `GET ${path}`);
    const status = (operation.parameters as JsonObject[]).find(
      ({ name }) => name === 'status',
    );
    assert(status, `GET ${path} must document status`);
    assert.equal(
      object(status.schema, `${path} status schema`).default,
      undefined,
      `${path} status default is conditional on lifecycle`,
    );
  }

  const platformList = object(
    object(paths['/v1/platform/users'], 'platform users path').get,
    'platform users GET',
  );
  const platformParameters = platformList.parameters as JsonObject[];
  const platformLimit = object(
    platformParameters.find(({ name }) => name === 'limit'),
    'platform users must document limit',
  );
  assert.equal(object(platformLimit.schema, 'platform user limit schema').maximum, 100);
  assert.equal(
    object(
      object(
        platformParameters.find(({ name }) => name === 'cursor'),
        'platform users must document cursor',
      ).schema,
      'platform user cursor schema',
    ).type,
    'string',
  );

  for (const schemaName of [
    'HouseholdResponseDto',
    'MembershipResponseDto',
    'MembershipDirectoryResponseDto',
    'ProductResponseDto',
    'RouteResponseDto',
    'SubscriptionResponseDto',
    'UserResponseDto',
  ]) {
    const schema = object(schemas[schemaName], `${schemaName} must be documented`);
    const properties = object(schema.properties, `${schemaName} properties`);
    assert.deepEqual(
      object(properties.lifecycle, `${schemaName} lifecycle`).enum,
      ['current', 'deleted'],
    );
    assert(
      (schema.required as string[]).includes('lifecycle'),
      `${schemaName} lifecycle must be required`,
    );
  }

  for (const [schemaName, schemaValue] of Object.entries(schemas)) {
    const schema = object(schemaValue, `${schemaName} schema`);
    if (schema.properties === undefined) continue;
    const properties = object(schema.properties, `${schemaName} properties`);
    for (const forbidden of ['deletedAt', 'deletedBy', 'deletionReason']) {
      assert.equal(
        forbidden in properties,
        false,
        `${schemaName} must not expose ${forbidden}`,
      );
    }
  }

  let deleteCount = 0;
  for (const [path, pathValue] of Object.entries(paths)) {
    const deleteOperation = object(pathValue, `${path} path`).delete;
    if (deleteOperation === undefined) continue;
    deleteCount += 1;
    const responses = object(
      object(deleteOperation, `DELETE ${path}`).responses,
      `DELETE ${path} responses`,
    );
    assert(responses['204'], `DELETE ${path} must retain 204`);
    assert.equal(object(responses['204'], `DELETE ${path} 204`).content, undefined);
  }
  assert(deleteCount > 0, 'the contract must include delete operations');
});
