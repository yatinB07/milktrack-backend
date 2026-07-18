-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'deactivated');

-- CreateEnum
CREATE TYPE "IdentityType" AS ENUM ('phone', 'email');

-- CreateEnum
CREATE TYPE "MfaFactorType" AS ENUM ('totp');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('pending_approval', 'onboarding', 'trial', 'active', 'suspended', 'closed');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('vendor_owner', 'vendor_administrator', 'delivery_agent', 'customer');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('invited', 'active', 'ended');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('product_owner', 'platform_administrator', 'support_operations');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('sign_in');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "deactivated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "deletion_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "IdentityType" NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_credentials" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),

    CONSTRAINT "password_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "MfaFactorType" NOT NULL,
    "encrypted_secret" TEXT NOT NULL,
    "enabled_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_mfa_authentications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "password_credential_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_mfa_authentications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "identity_id" UUID,
    "token_hash" TEXT NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(6),
    "request_ip_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token_hash" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "predecessor_id" UUID,
    "device_id" TEXT NOT NULL,
    "device_name" TEXT,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "access_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "VendorStatus" NOT NULL DEFAULT 'pending_approval',
    "timezone" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "skip_cutoff_minutes" INTEGER NOT NULL,
    "billing_day" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "deletion_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_memberships" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'invited',
    "joined_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "deletion_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vendor_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "platform_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_access_grants" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "grantee_user_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "approved_by" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "scope_json" JSONB NOT NULL,
    "access_mode" TEXT NOT NULL DEFAULT 'read',
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "vendor_id" UUID,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "reason" TEXT,
    "correlation_id" UUID NOT NULL,
    "ip_hash" TEXT,
    "device_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_type_normalized_value_key" ON "user_identities"("type", "normalized_value");

-- CreateIndex
CREATE INDEX "mfa_factors_user_id_revoked_at_idx" ON "mfa_factors"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "pending_mfa_authentications_token_hash_key" ON "pending_mfa_authentications"("token_hash");

-- CreateIndex
CREATE INDEX "pending_mfa_authentications_user_id_expires_at_idx" ON "pending_mfa_authentications"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "otp_challenges_token_hash_key" ON "otp_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "otp_challenges_destination_hash_purpose_created_at_idx" ON "otp_challenges"("destination_hash", "purpose", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_access_token_hash_key" ON "sessions"("access_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_predecessor_id_key" ON "sessions"("predecessor_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_expires_at_idx" ON "sessions"("user_id", "revoked_at", "expires_at");

-- CreateIndex
CREATE INDEX "vendor_memberships_vendor_id_status_id_idx" ON "vendor_memberships"("vendor_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_memberships_vendor_id_id_key" ON "vendor_memberships"("vendor_id", "id");

-- CreateIndex
CREATE INDEX "platform_role_assignments_user_id_revoked_at_idx" ON "platform_role_assignments"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "support_access_grants_vendor_id_grantee_user_id_expires_at_idx" ON "support_access_grants"("vendor_id", "grantee_user_id", "expires_at");

-- CreateIndex
CREATE INDEX "audit_events_vendor_id_created_at_id_idx" ON "audit_events"("vendor_id", "created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_mfa_authentications" ADD CONSTRAINT "pending_mfa_authentications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "user_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_memberships" ADD CONSTRAINT "vendor_memberships_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_memberships" ADD CONSTRAINT "vendor_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "vendors" ADD CONSTRAINT "vendors_currency_check" CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_billing_day_check" CHECK (billing_day BETWEEN 1 AND 28);
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_skip_cutoff_check" CHECK (skip_cutoff_minutes >= 0);
CREATE UNIQUE INDEX "vendors_code_active_key" ON "vendors" (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX "vendor_memberships_active_key"
  ON "vendor_memberships" (vendor_id, user_id, role)
  WHERE deleted_at IS NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX "user_identities_primary_key"
  ON "user_identities" (user_id, type) WHERE is_primary;
CREATE UNIQUE INDEX "platform_role_assignments_active_key"
  ON "platform_role_assignments" (user_id, role) WHERE revoked_at IS NULL;

ALTER TABLE "vendor_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "vendor_memberships_tenant" ON "vendor_memberships"
USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE "support_access_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_access_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "support_access_grants_tenant" ON "support_access_grants"
USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_events_select" ON "audit_events" FOR SELECT
USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);
CREATE POLICY "audit_events_insert" ON "audit_events" FOR INSERT
WITH CHECK (
  (vendor_id IS NULL AND NULLIF(current_setting('app.vendor_id', true), '') IS NULL)
  OR vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid
);

GRANT SELECT, INSERT, UPDATE, DELETE ON "users", "user_identities", "password_credentials",
  "mfa_factors", "pending_mfa_authentications", "otp_challenges", "sessions", "vendors", "vendor_memberships",
  "platform_role_assignments", "support_access_grants" TO milktrack_app;
GRANT SELECT, INSERT ON "audit_events" TO milktrack_app;
REVOKE UPDATE, DELETE ON "audit_events" FROM milktrack_app;
