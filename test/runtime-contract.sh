#!/bin/sh
set -eu

production_image="${1:-milktrack-backend:production}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_PREFIX='milktrack-runtime'
. "$SCRIPT_DIR/isolated-compose.sh"

runtime_container="${PROJECT}-production-api-contract"
worker_container="${PROJECT}-production-worker-contract"

cleanup_runtime_containers() {
  docker rm --force "$runtime_container" >/dev/null 2>&1 || true
  docker rm --force "$worker_container" >/dev/null 2>&1 || true
}
ISOLATED_CLEANUP_HOOK=cleanup_runtime_containers

isolated_preflight
isolated_install_traps

docker run --rm --entrypoint node "$production_image" --input-type=module --eval '
  import { existsSync } from "node:fs";

  if (process.getuid() === 0) {
    throw new Error("production image must not run as root");
  }

  for (const modulePath of ["prisma", "@prisma/dev", "@hono/node-server"]) {
    if (existsSync(`/app/node_modules/${modulePath}`)) {
      throw new Error(`production image must omit ${modulePath}`);
    }
  }

  for (const modulePath of ["@prisma/client", "@prisma/adapter-pg", "pg"]) {
    if (!existsSync(`/app/node_modules/${modulePath}`)) {
      throw new Error(`production image must include ${modulePath}`);
    }
  }
'
echo 'production image contract: passed'

isolated_compose build migrate
isolated_compose up -d --wait --wait-timeout 120 postgres
isolated_compose run --rm migrate

role_flags="$(
  isolated_compose exec -T postgres psql \
    --username milktrack_owner \
    --dbname milktrack \
    --tuples-only \
    --no-align \
    --command "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'milktrack_app';"
)"

if [ "$role_flags" != 't|f|f|f|f|f' ]; then
  echo "runtime role flags: expected t|f|f|f|f|f, got $role_flags" >&2
  exit 1
fi
echo 'runtime role flags: passed'

privileges="$(
  isolated_compose exec -T postgres psql \
    --username milktrack_owner \
    --dbname milktrack \
    --tuples-only \
    --no-align \
    --command "SELECT has_database_privilege('milktrack_app', 'milktrack', 'CONNECT'), has_database_privilege('milktrack_app', 'milktrack', 'TEMPORARY'), has_schema_privilege('milktrack_app', 'public', 'USAGE'), has_schema_privilege('milktrack_app', 'public', 'CREATE');"
)"

if [ "$privileges" != 't|f|t|f' ]; then
  echo "runtime privileges: expected t|f|t|f, got $privileges" >&2
  exit 1
fi
echo 'runtime privileges: passed'

docker run --detach \
  --name "$runtime_container" \
  --network "${PROJECT}_default" \
  --env DATABASE_URL="$APP_URL" \
  --env AUTH_HMAC_KEY="$AUTH_HMAC_KEY_VALUE" \
  --env MFA_ENCRYPTION_KEY="$MFA_ENCRYPTION_KEY_VALUE" \
  --env SESSION_TTL_SECONDS="$SESSION_TTL_SECONDS_VALUE" \
  --env APP_ENV="$APP_ENV_VALUE" \
  --env OTP_PROVIDER="$OTP_PROVIDER_VALUE" \
  --env TRUST_PROXY_CIDRS="$TRUST_PROXY_CIDRS_VALUE" \
  "$production_image" >/dev/null

attempt=0
until docker exec "$runtime_container" node --input-type=module --eval \
  "fetch('http://127.0.0.1:3000/v1/health').then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1))"
do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    docker logs "$runtime_container" >&2
    echo 'production image did not become healthy within 120 seconds' >&2
    exit 1
  fi
  sleep 2
done

if docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$runtime_container" \
  | grep -Eq '^(TEST_OWNER_DATABASE_URL|MIGRATION_DATABASE_URL)='
then
  echo 'production runtime received an owner database URL' >&2
  exit 1
fi
echo 'production runtime boot and owner URL isolation: passed'

docker run --detach \
  --name "$worker_container" \
  --network "${PROJECT}_default" \
  --env DATABASE_URL="$APP_URL" \
  "$production_image" \
  node dist/worker.js >/dev/null

attempt=0
until docker logs "$worker_container" 2>&1 | grep -q 'ScheduleWorkerModule dependencies initialized'
do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ] || [ "$(docker inspect --format '{{.State.Running}}' "$worker_container")" != true ]; then
    docker logs "$worker_container" >&2
    echo 'production worker did not initialize within 120 seconds' >&2
    exit 1
  fi
  sleep 2
done

runtime_image_id="$(docker inspect --format '{{.Image}}' "$runtime_container")"
worker_image_id="$(docker inspect --format '{{.Image}}' "$worker_container")"
expected_image_id="$(docker image inspect --format '{{.Id}}' "$production_image")"
if [ "$runtime_image_id" != "$expected_image_id" ] || [ "$worker_image_id" != "$expected_image_id" ]; then
  echo 'production API and worker must use the same immutable image' >&2
  exit 1
fi

if [ -n "$(docker port "$worker_container")" ]; then
  echo 'production worker published a port' >&2
  exit 1
fi
if docker exec "$worker_container" node --input-type=module --eval \
  "fetch('http://127.0.0.1:3000/v1/health').then(() => process.exit(0), () => process.exit(1))"
then
  echo 'production worker opened the HTTP listener' >&2
  exit 1
fi
if docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$worker_container" \
  | grep -Eq '^(TEST_OWNER_DATABASE_URL|MIGRATION_DATABASE_URL|AUTH_HMAC_KEY|MFA_ENCRYPTION_KEY)='
then
  echo 'production worker received non-runtime credentials' >&2
  exit 1
fi
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$worker_container" \
  | grep -q '^DATABASE_URL=postgresql://milktrack_app:'

docker stop --time 10 "$worker_container" >/dev/null
worker_exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$worker_container")"
if [ "$worker_exit_code" != 0 ]; then
  docker logs "$worker_container" >&2
  echo "production worker exited with code $worker_exit_code after SIGTERM" >&2
  exit 1
fi
echo 'production API/worker same-image, no-port, runtime-credential, and shutdown contract: passed'
