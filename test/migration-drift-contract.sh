#!/bin/sh
set -eu

PROJECT="milktrack-p2be05-drift-$(date +%s)-$$"
ENV_FILE='.env.example'
COMPOSE_FILE='compose.yaml'
APP_URL='postgresql://milktrack_app:milktrack_app_local@postgres:5432/milktrack'
OWNER_URL='postgresql://milktrack_owner:milktrack_owner_local@postgres:5432/milktrack'
SHADOW_URL='postgresql://milktrack_owner:milktrack_owner_local@postgres:5432/milktrack_shadow'

if [ "$PROJECT" = "milktrack-backend" ]; then
  echo 'Refusing to run against the persistent development Compose project' >&2
  exit 1
fi

cleanup() {
  status=$?
  trap - EXIT
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

compose() {
  POSTGRES_DB=milktrack \
  POSTGRES_USER=milktrack_owner \
  POSTGRES_PASSWORD=milktrack_owner_local \
  MILKTRACK_APP_PASSWORD=milktrack_app_local \
  DATABASE_URL="$APP_URL" \
  MIGRATION_DATABASE_URL="$OWNER_URL" \
    docker compose --project-name "$PROJECT" --profile test \
      --env-file "$ENV_FILE" --file "$COMPOSE_FILE" "$@"
}

diff_schema() {
  compose run --rm -e SHADOW_DATABASE_URL="$SHADOW_URL" migrate sh -eu <<'SH'
MIGRATIONS="$(mktemp -d)"
CONFIG="$(mktemp ./p2-drift-prisma.XXXXXX.ts)"
cleanup_diff() { rm -rf "$MIGRATIONS" "$CONFIG"; }
trap cleanup_diff EXIT HUP INT TERM
cp -R prisma/migrations/. "$MIGRATIONS"
printf 'provider = "postgresql"\n' > "$MIGRATIONS/migration_lock.toml"
printf '%s\n' \
  "import { defineConfig, env } from 'prisma/config';" \
  "export default defineConfig({" \
  "  schema: '/app/prisma/schema.prisma'," \
  "  datasource: {" \
  "    url: env('DATABASE_URL')," \
  "    shadowDatabaseUrl: env('SHADOW_DATABASE_URL')," \
  "  }," \
  "});" > "$CONFIG"
npx prisma migrate diff --config "$CONFIG" --exit-code \
  --from-migrations "$MIGRATIONS" --to-config-datasource
SH
}

psql_owner() {
  compose exec -T postgres sh -c \
    'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1'
}

command -v docker >/dev/null
test -f "$ENV_FILE"
test -f "$COMPOSE_FILE"

compose build migrate
compose up -d --wait --wait-timeout 120 postgres
compose run --rm migrate
compose run --rm migrate npx prisma migrate status
printf '%s\n' 'CREATE DATABASE milktrack_shadow;' | compose exec -T postgres sh -c \
  'psql --username "$POSTGRES_USER" --dbname postgres --set=ON_ERROR_STOP=1'
diff_schema

printf '%s\n' 'ALTER TABLE vendors ADD COLUMN p2_drift_probe TEXT;' | psql_owner
set +e
diff_schema
drift_status=$?
set -e
if [ "$drift_status" -ne 2 ]; then
  echo "Expected Prisma drift exit 2, received $drift_status" >&2
  exit 1
fi

printf '%s\n' 'ALTER TABLE vendors DROP COLUMN p2_drift_probe;' | psql_owner
diff_schema
