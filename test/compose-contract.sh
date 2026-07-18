#!/bin/sh
set -eu

config_file="$(mktemp)"
test_config_file="$(mktemp)"
trap 'rm -f "$config_file" "$test_config_file"' EXIT

docker compose config >"$config_file"
docker compose --profile test config >"$test_config_file"

service_block() {
  awk -v service="$1" '
    $0 == "  " service ":" { found = 1 }
    found && $0 ~ /^  [^ ]/ && $0 != "  " service ":" { exit }
    found { print }
  ' "$config_file"
}

services="$(
  awk '
    /^services:$/ { in_services = 1; next }
    in_services && /^[^ ]/ { exit }
    in_services && /^  [^ ]+:$/ {
      name = $1
      sub(/:$/, "", name)
      print name
    }
  ' "$config_file" | LC_ALL=C sort
)"
expected_services="backend
migrate
postgres"
[ "$services" = "$expected_services" ]
! grep -q '^  integration:$' "$config_file"

test_services="$(
  awk '
    /^services:$/ { in_services = 1; next }
    in_services && /^[^ ]/ { exit }
    in_services && /^  [^ ]+:$/ {
      name = $1
      sub(/:$/, "", name)
      print name
    }
  ' "$test_config_file" | LC_ALL=C sort
)"
expected_test_services="backend
integration
migrate
postgres"
[ "$test_services" = "$expected_test_services" ]

grep -q '^  postgres_data:$' "$config_file"
grep -q 'target: /var/lib/postgresql$' "$config_file"

postgres="$(service_block postgres)"
! printf '%s\n' "$postgres" | grep -q '^    ports:$'

migrate="$(service_block migrate)"
printf '%s\n' "$migrate" | grep -q '^      postgres:$'
printf '%s\n' "$migrate" | grep -q 'condition: service_healthy$'

backend="$(service_block backend)"
printf '%s\n' "$backend" | grep -q '^      migrate:$'
printf '%s\n' "$backend" | grep -q 'condition: service_completed_successfully$'
printf '%s\n' "$backend" | grep -q 'http://127.0.0.1:3000/v1/health'
printf '%s\n' "$backend" | grep -q 'postgresql://milktrack_app:'
! printf '%s\n' "$backend" | grep -q 'postgresql://milktrack_owner:'
! printf '%s\n' "$backend" | grep -q 'TEST_OWNER_DATABASE_URL:'
! printf '%s\n' "$backend" | grep -q 'MIGRATION_DATABASE_URL:'

integration="$(
  awk '
    $0 == "  integration:" { found = 1 }
    found && $0 ~ /^  [^ ]/ && $0 != "  integration:" { exit }
    found { print }
  ' "$test_config_file"
)"
printf '%s\n' "$integration" | grep -q 'TEST_OWNER_DATABASE_URL:'
printf '%s\n' "$integration" | grep -q 'postgresql://milktrack_app:'
printf '%s\n' "$integration" | grep -q 'postgresql://milktrack_owner:'
[ "$(grep -c 'TEST_OWNER_DATABASE_URL:' "$test_config_file")" -eq 1 ]

production_dependencies="$(
  awk '
    $0 == "FROM base AS production-dependencies" { found = 1 }
    found && /^FROM / && $0 != "FROM base AS production-dependencies" { exit }
    found { print }
  ' Dockerfile
)"
if ! printf '%s\n' "$production_dependencies" | grep -q '^RUN npm ci --omit=dev --omit=optional$'; then
  echo 'production dependencies must use npm ci --omit=dev --omit=optional' >&2
  exit 1
fi
grep -q '^COPY --from=production-dependencies .* /app/node_modules ./node_modules$' Dockerfile
! grep -q 'npm prune --omit=dev' Dockerfile
