import assert from 'node:assert/strict';
import test from 'node:test';

import { SchedulingVendorService } from '../src/vendors/application/scheduling-vendor.service.js';
import { PrismaSchedulingVendorService } from '../src/vendors/infrastructure/prisma-scheduling-vendor.service.js';
import { VendorsModule } from '../src/vendors/vendors.module.js';

void test('VendorsModule binds and exports scheduling vendor discovery', () => {
  const providers = Reflect.getMetadata('providers', VendorsModule) as readonly unknown[];
  const exports = Reflect.getMetadata('exports', VendorsModule) as readonly unknown[];

  assert.ok(providers.includes(PrismaSchedulingVendorService));
  assert.ok(providers.some((provider) =>
    typeof provider === 'object'
    && provider !== null
    && 'provide' in provider
    && provider.provide === SchedulingVendorService
    && 'useExisting' in provider
    && provider.useExisting === PrismaSchedulingVendorService));
  assert.ok(exports.includes(SchedulingVendorService));
});
