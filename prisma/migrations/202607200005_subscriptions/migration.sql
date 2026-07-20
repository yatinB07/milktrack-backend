CREATE TABLE subscriptions (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  household_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ(6),
  deleted_by UUID,
  deletion_reason TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT subscriptions_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT subscriptions_household_fkey FOREIGN KEY (vendor_id, household_id)
    REFERENCES households(vendor_id, id),
  CONSTRAINT subscriptions_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id),
  CONSTRAINT subscriptions_version_check CHECK (version > 0),
  CONSTRAINT subscriptions_deletion_check CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_reason IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND deletion_reason = btrim(deletion_reason) AND char_length(deletion_reason) BETWEEN 1 AND 500)
  )
);

CREATE INDEX subscriptions_vendor_id_created_at_id_idx
  ON subscriptions (vendor_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX subscriptions_vendor_id_household_id_created_at_id_idx
  ON subscriptions (vendor_id, household_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE subscription_revisions (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  product_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  delivery_slot_id UUID NOT NULL,
  quantity NUMERIC(18,3) NOT NULL,
  status TEXT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by UUID NOT NULL,
  superseded_at TIMESTAMPTZ(6),
  superseded_by_revision_id UUID,
  supersession_reason TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT subscription_revisions_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_revisions_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT subscription_revisions_vendor_id_subscription_id_id_key
    UNIQUE (vendor_id, subscription_id, id),
  CONSTRAINT subscription_revisions_subscription_fkey FOREIGN KEY (vendor_id, subscription_id)
    REFERENCES subscriptions(vendor_id, id),
  CONSTRAINT subscription_revisions_product_unit_fkey FOREIGN KEY (vendor_id, product_id, unit_id)
    REFERENCES products(vendor_id, id, default_unit_id),
  CONSTRAINT subscription_revisions_delivery_slot_fkey FOREIGN KEY (vendor_id, delivery_slot_id)
    REFERENCES delivery_slots(vendor_id, id),
  CONSTRAINT subscription_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT subscription_revisions_quantity_check CHECK (quantity > 0),
  CONSTRAINT subscription_revisions_status_check CHECK (status IN ('active', 'paused', 'cancelled')),
  CONSTRAINT subscription_revisions_effective_period_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT subscription_revisions_supersession_check CHECK (
    (superseded_at IS NULL AND superseded_by_revision_id IS NULL AND supersession_reason IS NULL)
    OR (superseded_at IS NOT NULL AND superseded_by_revision_id IS NOT NULL
      AND supersession_reason = btrim(supersession_reason)
      AND char_length(supersession_reason) BETWEEN 1 AND 500)
  ),
  CONSTRAINT subscription_revisions_supersession_fkey
    FOREIGN KEY (vendor_id, subscription_id, superseded_by_revision_id)
    REFERENCES subscription_revisions(vendor_id, subscription_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT subscription_revisions_no_current_plan_overlap EXCLUDE USING gist (
    vendor_id WITH =,
    subscription_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL)
);

CREATE INDEX subscription_revisions_current_plan_idx
  ON subscription_revisions (vendor_id, subscription_id, effective_from, id)
  WHERE superseded_at IS NULL;
CREATE INDEX subscription_revisions_history_idx
  ON subscription_revisions (vendor_id, subscription_id, created_at DESC, id DESC);
CREATE INDEX subscription_revisions_duplicate_lookup_idx
  ON subscription_revisions (vendor_id, product_id, unit_id, delivery_slot_id, effective_from, effective_to)
  WHERE superseded_at IS NULL AND status = 'active';

CREATE TABLE subscription_revision_weekdays (
  vendor_id UUID NOT NULL,
  subscription_revision_id UUID NOT NULL,
  weekday SMALLINT NOT NULL,
  CONSTRAINT subscription_revision_weekdays_pkey PRIMARY KEY (vendor_id, subscription_revision_id, weekday),
  CONSTRAINT subscription_revision_weekdays_revision_fkey
    FOREIGN KEY (vendor_id, subscription_revision_id)
    REFERENCES subscription_revisions(vendor_id, id),
  CONSTRAINT subscription_revision_weekdays_weekday_check CHECK (weekday BETWEEN 1 AND 7)
);

CREATE FUNCTION enforce_subscription_revision_weekdays_nonempty() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_vendor_id UUID;
  revision_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'subscription_revisions' THEN
    revision_vendor_id := COALESCE(NEW.vendor_id, OLD.vendor_id);
    revision_id := COALESCE(NEW.id, OLD.id);
  ELSE
    revision_vendor_id := COALESCE(NEW.vendor_id, OLD.vendor_id);
    revision_id := COALESCE(NEW.subscription_revision_id, OLD.subscription_revision_id);
  END IF;
  IF EXISTS (SELECT 1 FROM subscription_revisions WHERE vendor_id = revision_vendor_id AND id = revision_id)
     AND NOT EXISTS (
       SELECT 1 FROM subscription_revision_weekdays
       WHERE vendor_id = revision_vendor_id AND subscription_revision_id = revision_id
     ) THEN
    RAISE EXCEPTION 'subscription revision % requires at least one weekday', revision_id
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_revision_weekdays_nonempty';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER subscription_revisions_weekdays_nonempty
AFTER INSERT OR UPDATE OF vendor_id, id ON subscription_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_subscription_revision_weekdays_nonempty();

CREATE CONSTRAINT TRIGGER subscription_revision_weekdays_nonempty
AFTER INSERT OR UPDATE OR DELETE ON subscription_revision_weekdays
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_subscription_revision_weekdays_nonempty();

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant_policy ON subscriptions
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE subscription_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_revisions_tenant_policy ON subscription_revisions
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE subscription_revision_weekdays ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_revision_weekdays FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_revision_weekdays_tenant_policy ON subscription_revision_weekdays
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT ON subscriptions, subscription_revisions, subscription_revision_weekdays TO milktrack_app;
GRANT UPDATE (version, deleted_at, deleted_by, deletion_reason, updated_at) ON subscriptions TO milktrack_app;
GRANT UPDATE (effective_to, superseded_at, superseded_by_revision_id, supersession_reason, updated_at)
  ON subscription_revisions TO milktrack_app;
