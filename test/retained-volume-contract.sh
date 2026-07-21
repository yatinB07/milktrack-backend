#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_PREFIX='milktrack-retained'
. "$SCRIPT_DIR/isolated-compose.sh"

migration_count() {
  isolated_compose exec -T postgres psql \
    --username milktrack_owner \
    --dbname milktrack \
    --tuples-only \
    --no-align \
    --command 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'
}

isolated_preflight
isolated_install_traps

expected="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [ "$expected" -lt 1 ]; then
  echo 'expected at least one migration directory' >&2
  exit 1
fi

# Deploy from this checkout so stale images cannot satisfy the persistence proof.
isolated_compose build migrate
isolated_compose up -d --wait --wait-timeout 120 postgres
isolated_compose run --rm migrate

before="$(migration_count)"
if [ "$before" != "$expected" ]; then
  echo "expected $expected deployed migrations before persistence check, found $before" >&2
  exit 1
fi

isolated_compose restart postgres
isolated_compose up -d --wait --wait-timeout 120 postgres
after_restart="$(migration_count)"

isolated_compose down --remove-orphans
isolated_compose up -d --wait --wait-timeout 120 postgres
after_down="$(migration_count)"

if [ "$expected" != "$after_restart" ] || [ "$expected" != "$after_down" ]; then
  echo "migration history was not retained: $expected/$after_restart/$after_down" >&2
  exit 1
fi

echo "retained database volume contract: passed ($expected migrations)"
