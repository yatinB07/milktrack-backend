#!/bin/sh
set -eu

migration_count() {
  docker compose exec -T postgres psql \
    --username milktrack_owner \
    --dbname milktrack \
    --tuples-only \
    --no-align \
    --command 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'
}

before="$(migration_count)"
if [ "$before" -lt 1 ]; then
  echo 'expected at least one deployed migration before persistence check' >&2
  exit 1
fi

docker compose restart postgres
docker compose up -d --wait --wait-timeout 120 postgres
after_restart="$(migration_count)"

docker compose down --remove-orphans
docker compose up -d --wait --wait-timeout 120 postgres
after_down="$(migration_count)"

if [ "$before" != "$after_restart" ] || [ "$before" != "$after_down" ]; then
  echo "migration history was not retained: $before/$after_restart/$after_down" >&2
  exit 1
fi

echo "retained database volume contract: passed ($before migrations)"
