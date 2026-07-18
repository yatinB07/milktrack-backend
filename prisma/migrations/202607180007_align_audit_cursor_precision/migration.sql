-- JavaScript cursors preserve milliseconds; normalize the ordered database column to the same precision.
ALTER TABLE "audit_events"
ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3);
