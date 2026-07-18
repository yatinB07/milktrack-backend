import { normalizeEmail, normalizePhone } from '../src/identity/domain/identity-normalization.js';
import { PasswordHasher } from '../src/identity/domain/password.js';
import { SecretBox } from '../src/identity/domain/secret-box.js';
import { Totp } from '../src/identity/domain/totp.js';
import { validateAuthenticationEnvironment } from '../src/bootstrap/auth-environment.js';
import { PrismaService } from '../src/database/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';

const seedUsers = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    displayName: 'Development Platform Administrator',
    emailTag: 'platform-admin',
    phone: '+15555550101',
    emailIdentityId: '20000000-0000-4000-8000-000000000001',
    phoneIdentityId: '20000000-0000-4000-8000-000000000002',
    factorId: '60000000-0000-4000-8000-000000000001',
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    displayName: 'Development Product Owner',
    emailTag: 'product-owner',
    phone: '+15555550102',
    emailIdentityId: '20000000-0000-4000-8000-000000000003',
    phoneIdentityId: '20000000-0000-4000-8000-000000000004',
    factorId: '60000000-0000-4000-8000-000000000002',
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    displayName: 'Development Vendor A Owner',
    emailTag: 'vendor-a-owner',
    phone: '+15555550103',
    emailIdentityId: '20000000-0000-4000-8000-000000000005',
    phoneIdentityId: '20000000-0000-4000-8000-000000000006',
    factorId: '60000000-0000-4000-8000-000000000003',
  },
  {
    id: '10000000-0000-4000-8000-000000000004',
    displayName: 'Development Vendor B Owner',
    emailTag: 'vendor-b-owner',
    phone: '+15555550104',
    emailIdentityId: '20000000-0000-4000-8000-000000000007',
    phoneIdentityId: '20000000-0000-4000-8000-000000000008',
    factorId: '60000000-0000-4000-8000-000000000004',
  },
] as const;

const seedVendors = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    code: 'DEV_VENDOR_A',
    legalName: 'Development Vendor A',
    displayName: 'Vendor A',
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    code: 'DEV_VENDOR_B',
    legalName: 'Development Vendor B',
    displayName: 'Vendor B',
  },
] as const;

const seedPlatformRoles = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    userId: seedUsers[0].id,
    role: 'platform_administrator' as const,
  },
  {
    id: '50000000-0000-4000-8000-000000000002',
    userId: seedUsers[1].id,
    role: 'product_owner' as const,
  },
] as const;

const seedMemberships = [
  {
    id: '40000000-0000-4000-8000-000000000001',
    vendorId: seedVendors[0].id,
    userId: seedUsers[2].id,
    role: 'vendor_owner' as const,
  },
  {
    id: '40000000-0000-4000-8000-000000000002',
    vendorId: seedVendors[1].id,
    userId: seedUsers[3].id,
    role: 'vendor_owner' as const,
  },
] as const;

type SeedConfiguration = Readonly<{
  password: string;
  totpSecret: string;
  mfaEncryptionKey: Buffer;
  emails: readonly string[];
}>;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function loadConfiguration(): SeedConfiguration {
  if (
    (process.env.APP_ENV !== 'development' && process.env.APP_ENV !== 'test') ||
    process.env.NODE_ENV === 'production'
  ) {
    throw new Error('Development seed is disabled outside development and test');
  }

  const baseEmail = normalizeEmail(required('SEED_ADMIN_EMAIL'));
  const separator = baseEmail.lastIndexOf('@');
  if (baseEmail.slice(separator + 1) !== 'example.test') {
    throw new Error('SEED_ADMIN_EMAIL must use the example.test domain');
  }
  const localPart = baseEmail.slice(0, separator);
  const password = required('SEED_ADMIN_PASSWORD');
  if (password.length < 12 || password.length > 1024) {
    throw new Error('SEED_ADMIN_PASSWORD must be between 12 and 1024 characters');
  }
  const totpSecret = required('SEED_TOTP_SECRET');
  new Totp().validateSecret(totpSecret);
  const { mfaEncryptionKey } = validateAuthenticationEnvironment(process.env);

  return {
    password,
    totpSecret,
    mfaEncryptionKey,
    emails: seedUsers.map(({ emailTag }) =>
      normalizeEmail(`${localPart}+${emailTag}@example.test`),
    ),
  };
}

function collision(entity: string): never {
  throw new Error(`Seed collision detected for ${entity}`);
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function preflight(
  tx: Prisma.TransactionClient,
  configuration: SeedConfiguration,
): Promise<void> {
  const identities = seedUsers.flatMap((user, index) => [
    {
      id: user.emailIdentityId,
      userId: user.id,
      type: 'email' as const,
      normalizedValue: configuration.emails[index],
    },
    {
      id: user.phoneIdentityId,
      userId: user.id,
      type: 'phone' as const,
      normalizedValue: normalizePhone(user.phone),
    },
  ]);
  const existingIdentities = await tx.userIdentity.findMany({
    where: {
      OR: [
        { id: { in: identities.map(({ id }) => id) } },
        ...identities.map(({ type, normalizedValue }) => ({ type, normalizedValue })),
      ],
    },
    select: { id: true, userId: true, type: true, normalizedValue: true },
  });
  for (const existing of existingIdentities) {
    if (
      !identities.some(
        (expected) =>
          expected.id === existing.id &&
          expected.userId === existing.userId &&
          expected.type === existing.type &&
          expected.normalizedValue === existing.normalizedValue,
      )
    ) {
      collision('identity');
    }
  }

  const existingUsers = await tx.user.findMany({
    where: { id: { in: seedUsers.map(({ id }) => id) } },
    select: { id: true },
  });
  for (const existing of existingUsers) {
    if (!existingIdentities.some(({ userId }) => userId === existing.id)) {
      collision('user');
    }
  }

  const existingVendors = await tx.vendor.findMany({
    where: {
      OR: [
        { id: { in: seedVendors.map(({ id }) => id) } },
        { code: { in: seedVendors.map(({ code }) => code) } },
      ],
    },
    select: { id: true, code: true },
  });
  for (const existing of existingVendors) {
    if (!seedVendors.some(({ id, code }) => id === existing.id && code === existing.code)) {
      collision('vendor');
    }
  }

  const existingFactors = await tx.mfaFactor.findMany({
    where: {
      OR: [
        { id: { in: seedUsers.map(({ factorId }) => factorId) } },
        {
          userId: { in: seedUsers.map(({ id }) => id) },
          type: 'totp',
          revokedAt: null,
        },
      ],
    },
    select: { id: true, userId: true, type: true },
  });
  for (const existing of existingFactors) {
    if (
      !seedUsers.some(
        ({ id, factorId }) =>
          factorId === existing.id && id === existing.userId && existing.type === 'totp',
      )
    ) {
      collision('MFA factor');
    }
  }

  const existingRoles = await tx.platformRoleAssignment.findMany({
    where: {
      OR: [
        { id: { in: seedPlatformRoles.map(({ id }) => id) } },
        ...seedPlatformRoles.map(({ userId, role }) => ({ userId, role, revokedAt: null })),
      ],
    },
    select: { id: true, userId: true, role: true },
  });
  for (const existing of existingRoles) {
    if (
      !seedPlatformRoles.some(
        ({ id, userId, role }) =>
          id === existing.id && userId === existing.userId && role === existing.role,
      )
    ) {
      collision('platform role');
    }
  }

  for (const membership of seedMemberships) {
    await tx.$executeRaw`SELECT set_config('app.vendor_id', ${membership.vendorId}, true)`;
    const existingMemberships = await tx.vendorMembership.findMany({
      where: {
        OR: [
          { id: membership.id },
          {
            vendorId: membership.vendorId,
            userId: membership.userId,
            role: membership.role,
            endedAt: null,
            deletedAt: null,
          },
        ],
      },
      select: { id: true, vendorId: true, userId: true, role: true },
    });
    if (
      existingMemberships.some(
        (existing) =>
          existing.id !== membership.id ||
          existing.vendorId !== membership.vendorId ||
          existing.userId !== membership.userId ||
          existing.role !== membership.role,
      )
    ) {
      collision('vendor membership');
    }
  }
}

async function createMissing(
  tx: Prisma.TransactionClient,
  configuration: SeedConfiguration,
): Promise<void> {
  const now = new Date();
  const passwords = new PasswordHasher();
  const secrets = new SecretBox(configuration.mfaEncryptionKey);

  for (const user of seedUsers) {
    const existing = await tx.user.findUnique({ where: { id: user.id }, select: { id: true } });
    if (existing === null) {
      await tx.user.create({ data: { id: user.id, displayName: user.displayName } });
    }
  }

  for (const [index, user] of seedUsers.entries()) {
    const identities = [
      {
        id: user.emailIdentityId,
        type: 'email' as const,
        normalizedValue: configuration.emails[index],
      },
      {
        id: user.phoneIdentityId,
        type: 'phone' as const,
        normalizedValue: normalizePhone(user.phone),
      },
    ];
    for (const identity of identities) {
      const existing = await tx.userIdentity.findUnique({
        where: { id: identity.id },
        select: { id: true },
      });
      if (existing === null) {
        await tx.userIdentity.create({
          data: {
            ...identity,
            userId: user.id,
            verifiedAt: now,
            isPrimary: true,
          },
        });
      }
    }

    const password = await tx.passwordCredential.findUnique({
      where: { userId: user.id },
      select: { userId: true },
    });
    if (password === null) {
      const encoded = await passwords.hash(configuration.password);
      await tx.passwordCredential.create({
        data: {
          userId: user.id,
          passwordHash: encoded.hash,
          salt: encoded.salt,
          algorithm: 'scrypt',
          parameters: encoded.parameters,
          changedAt: now,
        },
      });
    }

    const factor = await tx.mfaFactor.findUnique({
      where: { id: user.factorId },
      select: { id: true },
    });
    if (factor === null) {
      await tx.mfaFactor.create({
        data: {
          id: user.factorId,
          userId: user.id,
          type: 'totp',
          encryptedSecret: secrets.encrypt(configuration.totpSecret),
          enabledAt: now,
        },
      });
    }
  }

  for (const vendor of seedVendors) {
    const existing = await tx.vendor.findUnique({ where: { id: vendor.id }, select: { id: true } });
    if (existing === null) {
      await tx.vendor.create({
        data: {
          ...vendor,
          status: 'active',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
          skipCutoffMinutes: 120,
          billingDay: 1,
        },
      });
    }
  }

  for (const assignment of seedPlatformRoles) {
    const existing = await tx.platformRoleAssignment.findUnique({
      where: { id: assignment.id },
      select: { id: true },
    });
    if (existing === null) {
      await tx.platformRoleAssignment.create({
        data: { ...assignment, grantedBy: seedUsers[0].id },
      });
    }
  }

  for (const membership of seedMemberships) {
    await tx.$executeRaw`SELECT set_config('app.vendor_id', ${membership.vendorId}, true)`;
    const existing = await tx.vendorMembership.findUnique({
      where: { id: membership.id },
      select: { id: true },
    });
    if (existing === null) {
      // Forced RLS hides another tenant's matching UUID; the global primary key is the final
      // collision check, and its failure rolls back every write in this seed transaction.
      try {
        await tx.vendorMembership.create({
          data: { ...membership, status: 'active', joinedAt: now },
        });
      } catch (error) {
        if (hasPrismaCode(error, 'P2002')) collision('vendor membership');
        throw error;
      }
    }
  }
}

async function main(): Promise<void> {
  const configuration = loadConfiguration();
  const prisma = new PrismaService();
  try {
    await prisma.$transaction(async (tx) => {
      await preflight(tx, configuration);
      await createMissing(tx, configuration);
    });
    console.log('Development seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Development seed failed');
  process.exitCode = 1;
});
