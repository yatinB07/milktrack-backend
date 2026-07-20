CREATE TABLE schedule_generation_runs (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  trigger TEXT NOT NULL,
  trigger_local_date DATE NOT NULL,
  service_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token UUID,
  claimed_at TIMESTAMPTZ(6),
  lease_expires_at TIMESTAMPTZ(6),
  started_at TIMESTAMPTZ(6),
  finished_at TIMESTAMPTZ(6),
  failure_code TEXT,
  failure_message TEXT,
  requested_by_user_id UUID,
  created_count INTEGER,
  existing_count INTEGER,
  updated_count INTEGER,
  cancelled_count INTEGER,
  missing_price_count INTEGER,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT schedule_generation_runs_pkey PRIMARY KEY (id),
  CONSTRAINT schedule_generation_runs_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT schedule_generation_runs_vendor_id_fkey
    FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT schedule_generation_runs_requester_fkey
    FOREIGN KEY (requested_by_user_id) REFERENCES users(id),
  CONSTRAINT schedule_generation_runs_trigger_check CHECK (
    trigger IN ('automatic','manual','configuration_change')
  ),
  CONSTRAINT schedule_generation_runs_status_check CHECK (
    status IN ('queued','running','retry_wait','succeeded','failed')
  ),
  CONSTRAINT schedule_generation_runs_requester_consistency_check CHECK (
    (trigger = 'automatic' AND requested_by_user_id IS NULL)
    OR (trigger IN ('manual','configuration_change') AND requested_by_user_id IS NOT NULL)
  ),
  CONSTRAINT schedule_generation_runs_attempts_check CHECK (
    max_attempts > 0 AND attempt_count BETWEEN 0 AND max_attempts
  ),
  CONSTRAINT schedule_generation_runs_lease_consistency_check CHECK (
    (status = 'running'
      AND lease_token IS NOT NULL
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND claimed_at < lease_expires_at)
    OR (status <> 'running'
      AND lease_token IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL)
  ),
  CONSTRAINT schedule_generation_runs_result_consistency_check CHECK (
    (status = 'queued'
      AND trigger <> 'manual'
      AND attempt_count = 0
      AND started_at IS NULL AND finished_at IS NULL
      AND failure_code IS NULL AND failure_message IS NULL
      AND created_count IS NULL AND existing_count IS NULL AND updated_count IS NULL
      AND cancelled_count IS NULL AND missing_price_count IS NULL)
    OR (status = 'running'
      AND attempt_count > 0
      AND started_at IS NOT NULL AND finished_at IS NULL
      AND failure_code IS NULL AND failure_message IS NULL
      AND created_count IS NULL AND existing_count IS NULL AND updated_count IS NULL
      AND cancelled_count IS NULL AND missing_price_count IS NULL)
    OR (status = 'retry_wait'
      AND attempt_count > 0
      AND started_at IS NOT NULL AND finished_at IS NULL
      AND failure_code IS NOT NULL
      AND failure_code = btrim(failure_code) AND char_length(failure_code) BETWEEN 1 AND 128
      AND failure_message IS NOT NULL
      AND failure_message = btrim(failure_message) AND char_length(failure_message) BETWEEN 1 AND 500
      AND created_count IS NULL AND existing_count IS NULL AND updated_count IS NULL
      AND cancelled_count IS NULL AND missing_price_count IS NULL)
    OR (status = 'succeeded'
      AND attempt_count > 0
      AND started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at
      AND failure_code IS NULL AND failure_message IS NULL
      AND created_count IS NOT NULL AND created_count >= 0
      AND existing_count IS NOT NULL AND existing_count >= 0
      AND updated_count IS NOT NULL AND updated_count >= 0
      AND cancelled_count IS NOT NULL AND cancelled_count >= 0
      AND missing_price_count IS NOT NULL AND missing_price_count >= 0)
    OR (status = 'failed'
      AND attempt_count > 0
      AND started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at
      AND failure_code IS NOT NULL
      AND failure_code = btrim(failure_code) AND char_length(failure_code) BETWEEN 1 AND 128
      AND failure_message IS NOT NULL
      AND failure_message = btrim(failure_message) AND char_length(failure_message) BETWEEN 1 AND 500
      AND created_count IS NULL AND existing_count IS NULL AND updated_count IS NULL
      AND cancelled_count IS NULL AND missing_price_count IS NULL)
  )
);

CREATE UNIQUE INDEX schedule_generation_runs_automatic_key
  ON schedule_generation_runs (vendor_id, trigger_local_date, service_date)
  WHERE trigger = 'automatic';
CREATE UNIQUE INDEX schedule_generation_runs_open_configuration_key
  ON schedule_generation_runs (vendor_id, service_date)
  WHERE trigger = 'configuration_change' AND status IN ('queued','running','retry_wait');
CREATE INDEX schedule_generation_runs_due_claim_idx
  ON schedule_generation_runs (vendor_id, status, available_at, created_at, id)
  WHERE status IN ('queued','retry_wait');
CREATE INDEX schedule_generation_runs_expired_lease_idx
  ON schedule_generation_runs (vendor_id, lease_expires_at, created_at, id)
  WHERE status = 'running';
CREATE INDEX schedule_generation_runs_cursor_idx
  ON schedule_generation_runs (vendor_id, created_at DESC, id DESC);

ALTER TABLE schedule_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_generation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY schedule_generation_runs_tenant_policy ON schedule_generation_runs
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT ON schedule_generation_runs TO milktrack_app;
GRANT UPDATE (
  status, attempt_count, available_at, lease_token, claimed_at, lease_expires_at,
  started_at, finished_at, failure_code, failure_message, created_count,
  existing_count, updated_count, cancelled_count, missing_price_count, updated_at
) ON schedule_generation_runs TO milktrack_app;
