CREATE TABLE route_stop_plans (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  route_id UUID NOT NULL,
  delivery_slot_id UUID NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by UUID NOT NULL,
  superseded_at TIMESTAMPTZ(6),
  superseded_by_plan_id UUID,
  supersession_reason TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT route_stop_plans_pkey PRIMARY KEY (id),
  CONSTRAINT route_stop_plans_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT route_stop_plans_vendor_id_route_id_id_key UNIQUE (vendor_id, route_id, id),
  CONSTRAINT route_stop_plans_vendor_id_route_id_id_delivery_slot_id_key UNIQUE (vendor_id, route_id, id, delivery_slot_id),
  CONSTRAINT route_stop_plans_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT route_stop_plans_route_slot_fkey FOREIGN KEY (vendor_id, route_id, delivery_slot_id)
    REFERENCES routes(vendor_id, id, delivery_slot_id),
  CONSTRAINT route_stop_plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT route_stop_plans_period_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT route_stop_plans_supersession_check CHECK (
    (superseded_at IS NULL AND superseded_by_plan_id IS NULL AND supersession_reason IS NULL)
    OR (superseded_at IS NOT NULL AND superseded_by_plan_id IS NOT NULL
      AND supersession_reason = btrim(supersession_reason)
      AND char_length(supersession_reason) BETWEEN 3 AND 500)
  ),
  CONSTRAINT route_stop_plans_supersession_fkey
    FOREIGN KEY (vendor_id, route_id, superseded_by_plan_id)
    REFERENCES route_stop_plans(vendor_id, route_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX route_stop_plans_projection_idx
  ON route_stop_plans (vendor_id, route_id, effective_from, id)
  WHERE superseded_at IS NULL;
CREATE INDEX route_stop_plans_history_idx
  ON route_stop_plans (vendor_id, route_id, created_at DESC, id DESC);

CREATE TABLE route_stops (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  route_id UUID NOT NULL,
  plan_id UUID NOT NULL,
  household_id UUID NOT NULL,
  delivery_slot_id UUID NOT NULL,
  sequence INTEGER NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by UUID NOT NULL,
  superseded_at TIMESTAMPTZ(6),
  superseded_by_plan_id UUID,
  supersession_reason TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT route_stops_pkey PRIMARY KEY (id),
  CONSTRAINT route_stops_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT route_stops_plan_fkey FOREIGN KEY (vendor_id, route_id, plan_id)
    REFERENCES route_stop_plans(vendor_id, route_id, id),
  CONSTRAINT route_stops_route_slot_fkey FOREIGN KEY (vendor_id, route_id, delivery_slot_id)
    REFERENCES routes(vendor_id, id, delivery_slot_id),
  CONSTRAINT route_stops_household_fkey FOREIGN KEY (vendor_id, household_id)
    REFERENCES households(vendor_id, id),
  CONSTRAINT route_stops_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT route_stops_sequence_check CHECK (sequence > 0),
  CONSTRAINT route_stops_period_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT route_stops_supersession_check CHECK (
    (superseded_at IS NULL AND superseded_by_plan_id IS NULL AND supersession_reason IS NULL)
    OR (superseded_at IS NOT NULL AND superseded_by_plan_id IS NOT NULL
      AND supersession_reason = btrim(supersession_reason)
      AND char_length(supersession_reason) BETWEEN 3 AND 500)
  ),
  CONSTRAINT route_stops_no_sequence_overlap EXCLUDE USING gist (
    vendor_id WITH =, route_id WITH =, sequence WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL),
  CONSTRAINT route_stops_no_household_slot_overlap EXCLUDE USING gist (
    vendor_id WITH =, household_id WITH =, delivery_slot_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL)
);

CREATE INDEX route_stops_projection_idx
  ON route_stops (vendor_id, route_id, effective_from, sequence, id)
  WHERE superseded_at IS NULL;
CREATE INDEX route_stops_household_projection_idx
  ON route_stops (vendor_id, household_id, delivery_slot_id, effective_from)
  WHERE superseded_at IS NULL;
CREATE INDEX route_stops_history_idx
  ON route_stops (vendor_id, route_id, plan_id, sequence, id);

CREATE FUNCTION derive_route_stop_plan_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE selected route_stop_plans%ROWTYPE;
BEGIN
  SELECT * INTO selected FROM route_stop_plans
  WHERE vendor_id=NEW.vendor_id AND route_id=NEW.route_id AND id=NEW.plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'route stop plan is not available' USING ERRCODE='23503', CONSTRAINT='route_stops_plan_fkey';
  END IF;
  NEW.delivery_slot_id := selected.delivery_slot_id;
  NEW.effective_from := selected.effective_from;
  NEW.effective_to := selected.effective_to;
  NEW.superseded_at := selected.superseded_at;
  NEW.superseded_by_plan_id := selected.superseded_by_plan_id;
  NEW.supersession_reason := selected.supersession_reason;
  RETURN NEW;
END;
$$;

CREATE TRIGGER derive_route_stop_plan_fields
BEFORE INSERT OR UPDATE OF vendor_id, route_id, plan_id, delivery_slot_id,
  effective_from, effective_to, superseded_at, superseded_by_plan_id, supersession_reason
ON route_stops FOR EACH ROW EXECUTE FUNCTION derive_route_stop_plan_fields();

CREATE FUNCTION propagate_route_stop_plan_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE route_stops SET delivery_slot_id=NEW.delivery_slot_id,
    effective_from=NEW.effective_from, effective_to=NEW.effective_to,
    superseded_at=NEW.superseded_at, superseded_by_plan_id=NEW.superseded_by_plan_id,
    supersession_reason=NEW.supersession_reason, updated_at=now()
  WHERE vendor_id=NEW.vendor_id AND route_id=NEW.route_id AND plan_id=NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER propagate_route_stop_plan_fields
AFTER UPDATE OF delivery_slot_id, effective_from, effective_to, superseded_at,
  superseded_by_plan_id, supersession_reason ON route_stop_plans
FOR EACH ROW EXECUTE FUNCTION propagate_route_stop_plan_fields();

ALTER TABLE route_stop_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_stop_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY route_stop_plans_tenant_policy ON route_stop_plans
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE route_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_stops FORCE ROW LEVEL SECURITY;
CREATE POLICY route_stops_tenant_policy ON route_stops
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT ON route_stop_plans, route_stops TO milktrack_app;
GRANT UPDATE (effective_to, superseded_at, superseded_by_plan_id, supersession_reason, updated_at)
  ON route_stop_plans TO milktrack_app;
