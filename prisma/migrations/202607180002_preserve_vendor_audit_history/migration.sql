ALTER TABLE "audit_events"
DROP CONSTRAINT "audit_events_vendor_id_fkey",
ADD CONSTRAINT "audit_events_vendor_id_fkey"
  FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
