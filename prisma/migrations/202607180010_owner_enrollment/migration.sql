CREATE UNIQUE INDEX "user_identities_id_user_id_key"
  ON "user_identities"("id", "user_id");

CREATE TABLE "owner_enrollments" (
  "id" UUID NOT NULL,
  "vendor_id" UUID NOT NULL,
  "membership_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "setup_token_hash" TEXT NOT NULL,
  "completion_token_hash" TEXT,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "started_at" TIMESTAMPTZ(6),
  "consumed_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "retirement_reason" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "locked_at" TIMESTAMPTZ(6),
  "delivery_state" TEXT NOT NULL DEFAULT 'pending',
  "password_hash" TEXT,
  "password_salt" TEXT,
  "password_parameters" JSONB,
  "encrypted_mfa_secret" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "owner_enrollments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "owner_enrollments_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 0 AND 5),
  CONSTRAINT "owner_enrollments_delivery_state_check"
    CHECK ("delivery_state" IN ('pending', 'delivered', 'failed')),
  CONSTRAINT "owner_enrollments_retirement_state_check"
    CHECK (("retired_at" IS NULL) = ("retirement_reason" IS NULL)),
  CONSTRAINT "owner_enrollments_setup_state_check" CHECK (
    ("password_hash" IS NULL AND "password_salt" IS NULL
      AND "password_parameters" IS NULL AND "encrypted_mfa_secret" IS NULL
      AND "started_at" IS NULL AND "completion_token_hash" IS NULL)
    OR
    ("password_hash" IS NOT NULL AND "password_salt" IS NOT NULL
      AND "password_parameters" IS NOT NULL AND "encrypted_mfa_secret" IS NOT NULL
      AND "started_at" IS NOT NULL AND "completion_token_hash" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "owner_enrollments_membership_id_key"
  ON "owner_enrollments"("membership_id");
CREATE UNIQUE INDEX "owner_enrollments_setup_token_hash_key"
  ON "owner_enrollments"("setup_token_hash");
CREATE UNIQUE INDEX "owner_enrollments_completion_token_hash_key"
  ON "owner_enrollments"("completion_token_hash")
  WHERE "completion_token_hash" IS NOT NULL;
CREATE UNIQUE INDEX "owner_enrollments_open_user_key"
  ON "owner_enrollments"("user_id")
  WHERE "consumed_at" IS NULL AND "retired_at" IS NULL;
CREATE UNIQUE INDEX "owner_enrollments_open_vendor_key"
  ON "owner_enrollments"("vendor_id")
  WHERE "consumed_at" IS NULL AND "retired_at" IS NULL;
CREATE INDEX "owner_enrollments_vendor_id_expires_at_idx"
  ON "owner_enrollments"("vendor_id", "expires_at");

ALTER TABLE "owner_enrollments"
  ADD CONSTRAINT "owner_enrollments_vendor_id_fkey"
  FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "owner_enrollments"
  ADD CONSTRAINT "owner_enrollments_vendor_id_membership_id_fkey"
  FOREIGN KEY ("vendor_id", "membership_id")
  REFERENCES "vendor_memberships"("vendor_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "owner_enrollments"
  ADD CONSTRAINT "owner_enrollments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "owner_enrollments"
  ADD CONSTRAINT "owner_enrollments_identity_id_user_id_fkey"
  FOREIGN KEY ("identity_id", "user_id")
  REFERENCES "user_identities"("id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "owner_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "owner_enrollments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "owner_enrollments_tenant_isolation" ON "owner_enrollments"
  USING (
    "vendor_id" = NULLIF(current_setting('app.vendor_id', true), '')::uuid
  )
  WITH CHECK (
    "vendor_id" = NULLIF(current_setting('app.vendor_id', true), '')::uuid
  );

-- Anonymous callers can resolve only an exact unexpired one-time handle. The
-- returned identifiers are used to establish tenant context before table access.
CREATE FUNCTION "resolve_owner_enrollment_handle"(
  requested_hash TEXT,
  requested_phase TEXT
) RETURNS TABLE (enrollment_id UUID, vendor_id UUID, user_id UUID)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT oe.id, oe.vendor_id, oe.user_id
  FROM public.owner_enrollments oe
  WHERE oe.retired_at IS NULL AND oe.consumed_at IS NULL
    AND oe.locked_at IS NULL AND oe.expires_at > clock_timestamp()
    AND (
      (requested_phase = 'setup' AND oe.started_at IS NULL
        AND oe.setup_token_hash = requested_hash)
      OR
      (requested_phase = 'completion' AND oe.started_at IS NOT NULL
        AND oe.completion_token_hash = requested_hash)
    )
  LIMIT 1
$$;

REVOKE ALL ON TABLE "owner_enrollments" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON "owner_enrollments" TO milktrack_app;
REVOKE DELETE ON "owner_enrollments" FROM milktrack_app;
REVOKE ALL ON FUNCTION "resolve_owner_enrollment_handle"(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "resolve_owner_enrollment_handle"(TEXT, TEXT)
  TO milktrack_app;
