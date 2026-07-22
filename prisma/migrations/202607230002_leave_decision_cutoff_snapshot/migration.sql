DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM leave_occurrence_decisions LIMIT 1) THEN
    RAISE EXCEPTION 'cannot add required leave decision cutoff snapshot: existing decisions require an explicit historical repair';
  END IF;
END $$;

ALTER TABLE leave_occurrence_decisions
  ADD COLUMN cutoff_at TIMESTAMPTZ(6) NOT NULL;
