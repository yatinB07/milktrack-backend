ALTER TABLE "mfa_factors"
ADD COLUMN "last_used_counter" BIGINT;

UPDATE "mfa_factors"
SET "last_used_counter" = floor(extract(epoch FROM "last_used_at") / 30)::BIGINT
WHERE "last_used_at" IS NOT NULL;

ALTER TABLE "pending_mfa_authentications"
ADD COLUMN "request_ip_hash" TEXT;

CREATE INDEX "pending_mfa_authentications_request_ip_hash_created_at_idx"
ON "pending_mfa_authentications"("request_ip_hash", "created_at" DESC);

CREATE TABLE "administrator_authentication_attempts" (
  "id" UUID NOT NULL,
  "account_key" TEXT NOT NULL,
  "ip_hash" TEXT,
  "stage" TEXT NOT NULL,
  "succeeded" BOOLEAN NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "administrator_authentication_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "administrator_authentication_attempts_stage_check"
    CHECK ("stage" IN ('password', 'pending_mfa'))
);

CREATE INDEX "administrator_auth_attempts_account_stage_created_idx"
ON "administrator_authentication_attempts"("account_key", "stage", "created_at" DESC);

CREATE INDEX "administrator_auth_attempts_ip_stage_created_idx"
ON "administrator_authentication_attempts"("ip_hash", "stage", "created_at" DESC);

GRANT SELECT, INSERT, DELETE ON "administrator_authentication_attempts" TO milktrack_app;

ALTER TABLE "audit_events"
DROP CONSTRAINT "audit_events_actor_required_check",
ADD CONSTRAINT "audit_events_actor_required_check"
CHECK (
  "actor_user_id" IS NOT NULL
  OR (
    "vendor_id" IS NULL
    AND "action" IN (
      'auth.otp_challenge_issued',
      'auth.password_failed',
      'auth.mfa_failed'
    )
    AND "entity_type" = 'authentication'
  )
);

CREATE FUNCTION revoke_administrator_sessions_after_mfa_revocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('session-user:' || NEW."user_id"::text, 0)
  );
  UPDATE "sessions"
  SET "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP)
  WHERE "user_id" = NEW."user_id"
    AND "authentication_method" = 'administrator_mfa'
    AND "revoked_at" IS NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "mfa_factor_revocation_revokes_administrator_sessions"
AFTER UPDATE OF "revoked_at" ON "mfa_factors"
FOR EACH ROW
WHEN (OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NOT NULL)
EXECUTE FUNCTION revoke_administrator_sessions_after_mfa_revocation();
