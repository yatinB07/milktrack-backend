#!/bin/sh
set -eu

PROJECT="milktrack-security-$(date +%s)-$$"
COMPOSE_FILE="compose.yaml"
ENV_FILE=".env.example"
FOUNDATION="prisma/migrations/202607180001_phase_1_security_foundation/migration.sql"
SENTINEL_USER_ID="13000000-0000-4000-8000-000000000001"
SENTINEL_VENDOR_ID="13000000-0000-4000-8000-000000000002"
SENTINEL_MEMBERSHIP_ID="13000000-0000-4000-8000-000000000003"
SENTINEL_AUDIT_ID="13000000-0000-4000-8000-000000000004"
SENTINEL_SESSION_ID="13000000-0000-4000-8000-000000000005"

cleanup() {
  status=$?
  trap - EXIT
  docker compose --project-name "$PROJECT" --profile test \
    --env-file "$ENV_FILE" --file "$COMPOSE_FILE" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

compose() {
  docker compose --project-name "$PROJECT" --profile test \
    --env-file "$ENV_FILE" --file "$COMPOSE_FILE" "$@"
}

command -v docker >/dev/null
test -f "$FOUNDATION"

compose build migrate integration
compose up -d --wait --wait-timeout 120 postgres

compose exec -T postgres sh -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1' \
  < "$FOUNDATION"
compose run --rm migrate npx prisma migrate resolve \
  --applied 202607180001_phase_1_security_foundation

compose exec -T postgres sh -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1' <<SQL
INSERT INTO users (id, display_name, updated_at)
VALUES ('$SENTINEL_USER_ID', 'Task 13 retained sentinel', now());
INSERT INTO vendors
  (id, code, legal_name, display_name, status, timezone, currency,
   skip_cutoff_minutes, billing_day, created_at, updated_at)
VALUES
  ('$SENTINEL_VENDOR_ID', 'task13-retained', 'Task 13 Retained',
   'Task 13 Retained', 'active', 'Asia/Kolkata', 'INR', 0, 1,
   '2026-07-18T12:00:00.123900Z', now());
INSERT INTO vendor_memberships
  (id, vendor_id, user_id, role, status, joined_at, updated_at)
VALUES
  ('$SENTINEL_MEMBERSHIP_ID', '$SENTINEL_VENDOR_ID', '$SENTINEL_USER_ID',
   'vendor_owner', 'active', now(), now());
INSERT INTO audit_events
  (id, vendor_id, actor_user_id, action, entity_type, entity_id, correlation_id)
VALUES
  ('$SENTINEL_AUDIT_ID', '$SENTINEL_VENDOR_ID', '$SENTINEL_USER_ID',
   'task13.retained', 'vendor', '$SENTINEL_VENDOR_ID',
   '13000000-0000-4000-8000-000000000006');
INSERT INTO sessions
  (id, user_id, access_token_hash, refresh_token_hash, device_id,
   access_expires_at, expires_at, last_seen_at)
VALUES
  ('$SENTINEL_SESSION_ID', '$SENTINEL_USER_ID', 'task13-retained-access',
   'task13-retained-refresh', 'task13-retained-device',
   now() + interval '15 minutes', now() + interval '30 days', now());
SQL

compose run --rm migrate
if compose run --rm integration npm run test:security; then
  echo "test:security accepted missing SECURITY_SENTINEL_* variables" >&2
  exit 1
fi
compose run --rm \
  -e SECURITY_SENTINEL_USER_ID="$SENTINEL_USER_ID" \
  -e SECURITY_SENTINEL_VENDOR_ID="$SENTINEL_VENDOR_ID" \
  -e SECURITY_SENTINEL_MEMBERSHIP_ID="$SENTINEL_MEMBERSHIP_ID" \
  -e SECURITY_SENTINEL_AUDIT_ID="$SENTINEL_AUDIT_ID" \
  -e SECURITY_SENTINEL_SESSION_ID="$SENTINEL_SESSION_ID" \
  integration npm run test:security
