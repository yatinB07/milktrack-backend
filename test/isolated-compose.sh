#!/bin/sh

: "${PROJECT_PREFIX:?set a gate-specific PROJECT_PREFIX before sourcing isolated-compose.sh}"

ENV_FILE='.env.example'
COMPOSE_FILE='compose.yaml'
APP_URL='postgresql://milktrack_app:milktrack_app_local@postgres:5432/milktrack'
OWNER_URL='postgresql://milktrack_owner:milktrack_owner_local@postgres:5432/milktrack'
POSTGRES_DB_VALUE='milktrack'
POSTGRES_USER_VALUE='milktrack_owner'
POSTGRES_PASSWORD_VALUE='milktrack_owner_local'
MILKTRACK_APP_PASSWORD_VALUE='milktrack_app_local'
AUTH_HMAC_KEY_VALUE='MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
MFA_ENCRYPTION_KEY_VALUE='ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA='
SESSION_TTL_SECONDS_VALUE='2592000'
APP_ENV_VALUE='test'
OTP_PROVIDER_VALUE='local'
TRUST_PROXY_CIDRS_VALUE=''
PROJECT="${PROJECT_PREFIX}-$(date +%s)-$$"

reject_override() {
  name="$1"
  expected="$2"
  if printenv "$name" >/dev/null 2>&1 && [ "$(printenv "$name")" != "$expected" ]; then
    echo "unsafe $name override" >&2
    exit 1
  fi
}

isolated_compose() {
  POSTGRES_DB="$POSTGRES_DB_VALUE" POSTGRES_USER="$POSTGRES_USER_VALUE" \
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD_VALUE" \
  MILKTRACK_APP_PASSWORD="$MILKTRACK_APP_PASSWORD_VALUE" \
  DATABASE_URL="$APP_URL" TEST_OWNER_DATABASE_URL="$OWNER_URL" \
  MIGRATION_DATABASE_URL="$OWNER_URL" \
  AUTH_HMAC_KEY="$AUTH_HMAC_KEY_VALUE" MFA_ENCRYPTION_KEY="$MFA_ENCRYPTION_KEY_VALUE" \
  SESSION_TTL_SECONDS="$SESSION_TTL_SECONDS_VALUE" APP_ENV="$APP_ENV_VALUE" \
  OTP_PROVIDER="$OTP_PROVIDER_VALUE" TRUST_PROXY_CIDRS="$TRUST_PROXY_CIDRS_VALUE" \
    docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
      --file "$COMPOSE_FILE" --profile test "$@"
}

isolated_preflight() {
  case "$PROJECT_PREFIX" in
    ''|milktrack|milktrack-backend|default|*default*)
      echo "unsafe generated Compose project prefix: $PROJECT_PREFIX" >&2
      exit 1
      ;;
  esac
  case "${COMPOSE_PROJECT_NAME:-}" in
    milktrack|milktrack-backend|default|*default*)
      echo "unsafe Compose project marker: ${COMPOSE_PROJECT_NAME}" >&2
      exit 1
      ;;
  esac
  reject_override POSTGRES_DB "$POSTGRES_DB_VALUE"
  reject_override POSTGRES_USER "$POSTGRES_USER_VALUE"
  reject_override POSTGRES_PASSWORD "$POSTGRES_PASSWORD_VALUE"
  reject_override MILKTRACK_APP_PASSWORD "$MILKTRACK_APP_PASSWORD_VALUE"
  reject_override DATABASE_URL "$APP_URL"
  reject_override TEST_OWNER_DATABASE_URL "$OWNER_URL"
  reject_override MIGRATION_DATABASE_URL "$OWNER_URL"
  reject_override AUTH_HMAC_KEY "$AUTH_HMAC_KEY_VALUE"
  reject_override MFA_ENCRYPTION_KEY "$MFA_ENCRYPTION_KEY_VALUE"
  reject_override SESSION_TTL_SECONDS "$SESSION_TTL_SECONDS_VALUE"
  reject_override APP_ENV "$APP_ENV_VALUE"
  reject_override OTP_PROVIDER "$OTP_PROVIDER_VALUE"
  reject_override TRUST_PROXY_CIDRS "$TRUST_PROXY_CIDRS_VALUE"

  command -v docker >/dev/null
  test -f "$ENV_FILE"
  test -f "$COMPOSE_FILE"
  rendered="$(isolated_compose config)"
  normalized="$(printf '%s\n' "$rendered" | sed 's/^[[:space:]]*//')"
  has_rendered_line() { printf '%s\n' "$normalized" | grep -Fxq "$1"; }
  if ! has_rendered_line "name: $PROJECT" ||
     ! has_rendered_line "name: ${PROJECT}_postgres_data" ||
     ! has_rendered_line "POSTGRES_DB: $POSTGRES_DB_VALUE" ||
     ! has_rendered_line "POSTGRES_USER: $POSTGRES_USER_VALUE" ||
     ! has_rendered_line "POSTGRES_PASSWORD: $POSTGRES_PASSWORD_VALUE" ||
     ! has_rendered_line "MILKTRACK_APP_PASSWORD: $MILKTRACK_APP_PASSWORD_VALUE" ||
     ! has_rendered_line "DATABASE_URL: $APP_URL" ||
     ! has_rendered_line "DATABASE_URL: $OWNER_URL" ||
     ! has_rendered_line "TEST_OWNER_DATABASE_URL: $OWNER_URL" ||
     ! has_rendered_line "AUTH_HMAC_KEY: $AUTH_HMAC_KEY_VALUE" ||
     ! has_rendered_line "MFA_ENCRYPTION_KEY: $MFA_ENCRYPTION_KEY_VALUE" ||
     ! has_rendered_line "SESSION_TTL_SECONDS: \"$SESSION_TTL_SECONDS_VALUE\"" ||
     ! has_rendered_line "APP_ENV: $APP_ENV_VALUE" ||
     ! has_rendered_line "OTP_PROVIDER: $OTP_PROVIDER_VALUE" ||
     ! has_rendered_line 'TRUST_PROXY_CIDRS: ""'
  then
    echo 'unsafe rendered Compose configuration' >&2
    exit 1
  fi
}

isolated_cleanup() {
  status=$?
  trap - EXIT
  if [ -n "${ISOLATED_CLEANUP_HOOK:-}" ]; then
    "$ISOLATED_CLEANUP_HOOK" >/dev/null 2>&1 || true
  fi
  isolated_compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}

isolated_install_traps() {
  trap isolated_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}
