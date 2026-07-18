ALTER TABLE "audit_events"
ADD CONSTRAINT "audit_events_actor_required_check"
CHECK (
  "actor_user_id" IS NOT NULL
  OR (
    "vendor_id" IS NULL
    AND "action" = 'auth.otp_challenge_issued'
    AND "entity_type" = 'authentication'
  )
);
