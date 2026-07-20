#!/bin/sh
set -eu

production_image="${1:-milktrack-backend:production}"
project="${COMPOSE_PROJECT_NAME:-}"
runtime_container="${project:-milktrack}-production-api-contract"
worker_container="${project:-milktrack}-production-worker-contract"

cleanup() {
  docker rm --force "$runtime_container" >/dev/null 2>&1 || true
  docker rm --force "$worker_container" >/dev/null 2>&1 || true
}

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

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

role_flags="$(
  docker compose exec -T postgres psql \
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
  docker compose exec -T postgres psql \
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

if [ -z "$project" ]; then
  echo 'COMPOSE_PROJECT_NAME is required to locate the isolated Compose network' >&2
  exit 1
fi

docker run --detach \
  --name "$runtime_container" \
  --network "${project}_default" \
  --env DATABASE_URL=postgresql://milktrack_app:milktrack_app_local@postgres:5432/milktrack \
  --env AUTH_HMAC_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
  --env MFA_ENCRYPTION_KEY=ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA= \
  --env SESSION_TTL_SECONDS=2592000 \
  --env APP_ENV=test \
  --env OTP_PROVIDER=local \
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
  --network "${project}_default" \
  --env DATABASE_URL=postgresql://milktrack_app:milktrack_app_local@postgres:5432/milktrack \
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
