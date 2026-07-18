-- JavaScript dates preserve milliseconds, so cursor ordering must use the same precision.
ALTER TABLE "vendor_memberships"
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3);
