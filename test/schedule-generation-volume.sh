#!/bin/sh
set -eu

if [ "${P2_VOLUME_GATE:-}" != 1 ]; then
  echo 'P2_VOLUME_GATE=1 is required' >&2
  exit 1
fi

case "${COMPOSE_PROJECT_NAME:-}" in
  milktrack|milktrack-backend|default|*default*)
    echo "unsafe Compose project marker: ${COMPOSE_PROJECT_NAME}" >&2
    exit 1
    ;;
esac

project="milktrack-p2-volume-$(date +%s)-$$"

cleanup() {
  docker compose --env-file .env.example -p "$project" down -v --remove-orphans
  echo "volume gate cleanup complete: $project"
}
trap cleanup EXIT HUP INT TERM

echo "volume gate project: $project"
timeout 900 sh -c '
  project="$1"
  docker compose --env-file .env.example -p "$project" build migrate integration
  docker compose --env-file .env.example -p "$project" up -d postgres migrate
  docker compose --env-file .env.example -p "$project" run --rm \
    --env P2_VOLUME_GATE=1 integration \
    timeout 840 node --import tsx test/schedule-generation-volume.gate.ts
' sh "$project"
