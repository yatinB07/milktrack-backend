CREATE INDEX "vendor_memberships_user_id_status_vendor_id_auth_idx"
  ON "vendor_memberships"("user_id", "status", "vendor_id")
  WHERE "ended_at" IS NULL AND "deleted_at" IS NULL;

-- Authentication may inspect only whether an exact user has a customer or
-- delivery-agent membership at a vendor that can currently serve customers.
CREATE FUNCTION "has_phone_auth_membership"(
  requested_user_id UUID,
  include_active BOOLEAN,
  include_invited BOOLEAN
) RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.vendor_memberships vm
    JOIN public.vendors v ON v.id = vm.vendor_id
    WHERE vm.user_id = requested_user_id
      AND vm.role IN ('customer', 'delivery_agent')
      AND (
        (include_active AND vm.status = 'active')
        OR (include_invited AND vm.status = 'invited')
      )
      AND vm.ended_at IS NULL
      AND vm.deleted_at IS NULL
      AND v.status IN ('trial', 'active')
      AND v.deleted_at IS NULL
  )
$$;

-- Session construction receives only the membership fields needed to build
-- authorization context; no vendor or user record is exposed wholesale.
CREATE FUNCTION "authentication_authority_memberships"(
  requested_user_id UUID,
  include_onboarding BOOLEAN,
  include_trial BOOLEAN,
  include_active BOOLEAN
) RETURNS TABLE (
  membership_id UUID,
  vendor_id UUID,
  vendor_name TEXT,
  membership_role TEXT,
  membership_status TEXT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT vm.id, vm.vendor_id, v.display_name, vm.role::text, vm.status::text
  FROM public.vendor_memberships vm
  JOIN public.vendors v ON v.id = vm.vendor_id
  WHERE vm.user_id = requested_user_id
    AND vm.status = 'active'
    AND vm.ended_at IS NULL
    AND vm.deleted_at IS NULL
    AND (
      (include_onboarding AND v.status = 'onboarding')
      OR (include_trial AND v.status = 'trial')
      OR (include_active AND v.status = 'active')
    )
    AND v.deleted_at IS NULL
  ORDER BY vm.vendor_id, vm.id
$$;

-- The update and its audit inserts are one statement so either every accepted
-- invitation is audited or the entire authentication transaction fails.
CREATE FUNCTION "activate_invited_phone_memberships"(
  requested_user_id UUID,
  requested_at TIMESTAMPTZ,
  requested_correlation_id UUID,
  requested_device_id TEXT,
  requested_ip_hash TEXT
) RETURNS TABLE (membership_id UUID, vendor_id UUID)
LANGUAGE SQL
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH activated AS (
    UPDATE public.vendor_memberships vm
    SET status = 'active', joined_at = requested_at, updated_at = requested_at
    FROM public.vendors v
    WHERE vm.vendor_id = v.id
      AND vm.user_id = requested_user_id
      AND vm.role IN ('customer', 'delivery_agent')
      AND vm.status = 'invited'
      AND vm.ended_at IS NULL
      AND vm.deleted_at IS NULL
      AND v.status IN ('trial', 'active')
      AND v.deleted_at IS NULL
    RETURNING vm.id AS membership_id, vm.vendor_id
  ), audited AS (
    INSERT INTO public.audit_events (
      id,
      vendor_id,
      actor_user_id,
      action,
      entity_type,
      entity_id,
      new_value,
      correlation_id,
      ip_hash,
      device_id
    )
    SELECT
      gen_random_uuid(),
      activated.vendor_id,
      requested_user_id,
      'membership.invitation_accepted',
      'vendor_membership',
      activated.membership_id,
      jsonb_build_object('status', 'active'),
      requested_correlation_id,
      requested_ip_hash,
      requested_device_id
    FROM activated
    RETURNING entity_id AS membership_id, vendor_id
  )
  SELECT activated.membership_id, activated.vendor_id
  FROM activated
  JOIN audited USING (membership_id, vendor_id)
  ORDER BY activated.vendor_id, activated.membership_id
$$;

REVOKE ALL ON FUNCTION "has_phone_auth_membership"(UUID, BOOLEAN, BOOLEAN)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "has_phone_auth_membership"(UUID, BOOLEAN, BOOLEAN)
  TO milktrack_app;

REVOKE ALL ON FUNCTION "authentication_authority_memberships"(
  UUID, BOOLEAN, BOOLEAN, BOOLEAN
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "authentication_authority_memberships"(
  UUID, BOOLEAN, BOOLEAN, BOOLEAN
) TO milktrack_app;

REVOKE ALL ON FUNCTION "activate_invited_phone_memberships"(
  UUID, TIMESTAMPTZ, UUID, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "activate_invited_phone_memberships"(
  UUID, TIMESTAMPTZ, UUID, TEXT, TEXT
) TO milktrack_app;
