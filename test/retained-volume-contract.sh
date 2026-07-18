#!/bin/sh
set -eu

: "${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME to an isolated verification project}"

migration_count() {
  docker compose exec -T postgres psql \
    --username milktrack_owner \
    --dbname milktrack \
    --tuples-only \
    --no-align \
    --command 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'
}

expected="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [ "$expected" -lt 1 ]; then
  echo 'expected at least one migration directory' >&2
  exit 1
fi

# Build and deploy from the current checkout so a stale image or retained volume
# cannot make the persistence contract pass against an older schema.
docker compose build migrate
docker compose run --rm migrate

before="$(migration_count)"
if [ "$before" != "$expected" ]; then
  echo "expected $expected deployed migrations before persistence check, found $before" >&2
  exit 1
fi

docker compose restart postgres
docker compose up -d --wait --wait-timeout 120 postgres
after_restart="$(migration_count)"

docker compose down --remove-orphans
docker compose up -d --wait --wait-timeout 120 postgres
after_down="$(migration_count)"

if [ "$expected" != "$after_restart" ] || [ "$expected" != "$after_down" ]; then
  echo "migration history was not retained: $expected/$after_restart/$after_down" >&2
  exit 1
fi

echo "retained database volume contract: passed ($expected migrations)"
