#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_PREFIX='milktrack-p2be05-drift'
. "$SCRIPT_DIR/isolated-compose.sh"

SHADOW_URL='postgresql://milktrack_owner:milktrack_owner_local@postgres:5432/milktrack_shadow'

reject_override SHADOW_DATABASE_URL "$SHADOW_URL"
isolated_preflight
isolated_install_traps

diff_schema() {
  isolated_compose run --rm -e SHADOW_DATABASE_URL="$SHADOW_URL" migrate sh -eu <<'SH'
MIGRATIONS="$(mktemp -d)"
CONFIG="$(mktemp ./p2-drift-prisma.XXXXXX.ts)"
cleanup_diff() { rm -rf "$MIGRATIONS" "$CONFIG"; }
trap cleanup_diff EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
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
npx prisma migrate diff --config "$CONFIG" --exit-code \
  --from-migrations "$MIGRATIONS" --to-schema /app/prisma/schema.prisma
SH
}

psql_owner() {
  isolated_compose exec -T postgres sh -c \
    'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1'
}

isolated_compose build migrate
isolated_compose up -d --wait --wait-timeout 120 postgres
isolated_compose run --rm migrate
isolated_compose run --rm migrate npx prisma migrate status
printf '%s\n' 'CREATE DATABASE milktrack_shadow;' | isolated_compose exec -T postgres sh -c \
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
