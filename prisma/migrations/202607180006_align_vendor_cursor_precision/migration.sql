-- JavaScript cursors preserve milliseconds; normalize the ordered database column to the same precision.
ALTER TABLE "vendors"
ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3);
