CREATE TYPE "HouseholdStatus" AS ENUM ('active', 'inactive');
CREATE TYPE "HouseholdMemberStatus" AS ENUM ('active', 'ended');

CREATE TABLE households (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  account_number TEXT NOT NULL,
  name TEXT NOT NULL,
  address_line_1 TEXT NOT NULL,
  address_line_2 TEXT,
  locality TEXT,
  city TEXT NOT NULL,
  region TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  country_code CHAR(2) NOT NULL,
  latitude DECIMAL(9, 6),
  longitude DECIMAL(10, 6),
  status "HouseholdStatus" NOT NULL DEFAULT 'active',
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ(6),
  deleted_by UUID,
  deletion_reason TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT households_pkey PRIMARY KEY (id),
  CONSTRAINT households_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT households_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id)
);

CREATE TABLE household_members (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  household_id UUID NOT NULL,
  customer_membership_id UUID NOT NULL,
  status "HouseholdMemberStatus" NOT NULL DEFAULT 'active',
  joined_at TIMESTAMPTZ(6) NOT NULL,
  ended_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT household_members_pkey PRIMARY KEY (id),
  CONSTRAINT household_members_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT household_members_household_fkey FOREIGN KEY (vendor_id, household_id)
    REFERENCES households(vendor_id, id),
  CONSTRAINT household_members_customer_membership_fkey FOREIGN KEY (vendor_id, customer_membership_id)
    REFERENCES vendor_memberships(vendor_id, id)
);

ALTER TABLE households
  ADD CONSTRAINT households_coordinates_pair_check
    CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT households_latitude_check
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT households_longitude_check
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

ALTER TABLE household_members
  ADD CONSTRAINT household_members_lifecycle_check
    CHECK ((status = 'active' AND ended_at IS NULL)
        OR (status = 'ended' AND ended_at IS NOT NULL));

CREATE UNIQUE INDEX households_active_account_number_key
  ON households (vendor_id, account_number) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX household_members_active_link_key
  ON household_members (vendor_id, household_id, customer_membership_id)
  WHERE status = 'active';
CREATE INDEX households_vendor_id_created_at_id_idx ON households (vendor_id, created_at DESC, id DESC);
CREATE INDEX household_members_vendor_id_household_id_created_at_id_idx
  ON household_members (vendor_id, household_id, created_at DESC, id DESC);

ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE households FORCE ROW LEVEL SECURITY;
CREATE POLICY households_tenant_policy ON households
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE household_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_members FORCE ROW LEVEL SECURITY;
CREATE POLICY household_members_tenant_policy ON household_members
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON households, household_members TO milktrack_app;
