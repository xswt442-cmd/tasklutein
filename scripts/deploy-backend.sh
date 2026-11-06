#!/usr/bin/env bash
# Deploy the Tencent Cloud Docker stack (FastAPI, PostgreSQL, MCP, Caddy).
# Run on the target host from this checkout as the Docker-enabled maintainer
# account. Never as root and never with sudo: the account's docker group
# membership is the only privilege this script needs.
#
# The order is deliberate and synchronous:
#   db up -> pg_isready -> logical backup -> build -> alembic upgrade (blocking)
#   -> up -d -> wait for loopback /api/health -> verify PostgreSQL
#
# `docker compose up -d` returns before a container serves traffic, and a
# rebuilt image can still be failing behind a "Started" line. Success is only
# reported after the health poll passes. Schema changes are never rolled back
# automatically; the previous API/MCP image IDs are printed so a human can
# retag and restart them after reviewing the failure.
#
# This script does not touch Cloudflare. The Worker, Access applications and
# the Tunnel have their own release steps; verify the public entrypoint
# separately after this succeeds.
#
# It assumes a schema already tracked by Alembic. A brand-new data volume is
# initialised by apps/api/migrations/0001_init.sql, which needs the documented
# one-time `alembic stamp 0001_baseline` before `upgrade head`; the script stops
# at the migration step instead of guessing.
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy-backend.sh [--allow-dirty]

  --allow-dirty  Deploy a checkout with uncommitted changes. Without it the
                 script refuses so a deployment always matches a commit.

Exit codes: 0 deployed, 2 usage, 3 preflight, 4 backup, 5 build,
            6 migration, 7 containers, 8 health check.
EOF
}

allow_dirty=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) allow_dirty=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$repo_root"

compose_file="$repo_root/deploy/compose.yml"
env_file="$repo_root/deploy/.env"
compose=(docker compose -f "$compose_file" --env-file "$env_file")
step="preflight"

prev_images=""
cleanup_note() {
  printf 'deploy failed during: %s\n' "$step" >&2
  if [[ -n $prev_images ]]; then
    printf 'previous api/mcp image IDs (manual rollback only): %s\n' "$prev_images" >&2
  fi
  printf 'schema changes are not rolled back by this script\n' >&2
}
trap 'status=$?; cleanup_note; exit $status' ERR

# --- preflight -------------------------------------------------------------

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  echo "run as the Docker-enabled maintainer account, not root" >&2
  exit 3
fi
if [[ ! -f $compose_file ]]; then
  echo "missing $compose_file" >&2
  exit 3
fi
if [[ ! -f $env_file ]]; then
  echo "missing $env_file (copy deploy/.env.example and fill it in)" >&2
  exit 3
fi
env_mode="$(stat -c %a -- "$env_file")"
if (( (env_mode % 10) & 4 )); then
  echo "refusing to deploy: $env_file is world-readable ($env_mode)" >&2
  exit 3
fi
for tool in docker curl flock; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing $tool" >&2; exit 3; }
done
docker info >/dev/null 2>&1 || { echo "cannot reach the Docker daemon without sudo" >&2; exit 3; }

# Only one deploy at a time; a second one would migrate against half-updated
# containers. The lock lives outside the checkout so it never becomes a commit.
lock_file="${TMPDIR:-/tmp}/tasklutein-deploy.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
  echo "another deploy holds $lock_file" >&2
  exit 3
fi

git -C "$repo_root" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git checkout" >&2; exit 3; }
if [[ $allow_dirty -eq 0 ]]; then
  dirty="$(git -C "$repo_root" status --porcelain)"
  if [[ -n $dirty ]]; then
    echo "refusing to deploy a dirty checkout; commit, or pass --allow-dirty:" >&2
    printf '%s\n' "$dirty" >&2
    exit 3
  fi
fi
branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [[ $branch != main ]]; then
  echo "note: deploying branch '$branch', not 'main'" >&2
fi

running_image() {
  local service="$1" container
  container="$("${compose[@]}" ps -q "$service" 2>/dev/null | head -n1 || true)"
  [[ -n $container ]] || return 0
  docker inspect --format '{{.Image}}' "$container" 2>/dev/null | cut -c8-19 || true
}
prev_images="api=$(running_image api) mcp=$(running_image mcp)"

# --- database, backup ------------------------------------------------------

step="database"
"${compose[@]}" up -d db
db_ready=0
for (( attempt = 0; attempt < 30; attempt++ )); do
  if "${compose[@]}" exec -T db pg_isready -U tasklutein -d tasklutein >/dev/null 2>&1; then
    db_ready=1
    break
  fi
  sleep 2
done
if [[ $db_ready -eq 0 ]]; then
  echo "PostgreSQL did not become ready" >&2
  exit 7
fi

step="backup"
# Detect the existing production database by compose labels rather than by a
# compose flag, so an unknown `ps` option can never silently skip the backup.
if docker ps --filter 'label=com.docker.compose.project=deploy' \
     --filter 'label=com.docker.compose.service=db' \
     --format '{{.Names}}' | grep -q .; then
  # The backup script verifies the compose project label itself and refuses to
  # overwrite an existing snapshot. Its dump stays on this host by design.
  bash "$repo_root/scripts/production-backup.sh"
fi

# --- build, migrate, replace ----------------------------------------------

step="build"
"${compose[@]}" build api mcp

step="migration"
# Runs in the new image, before any container is replaced: a failed migration
# leaves the previous API/MCP serving traffic.
"${compose[@]}" run --rm --no-deps api alembic upgrade head

step="containers"
# Caddy is left alone: it picks up api/mcp through the Compose network and only
# needs replacing when deploy/Caddyfile itself changes.
"${compose[@]}" up -d --no-deps api mcp

# --- verification ----------------------------------------------------------

step="health"
addr="$("${compose[@]}" port api 8000 2>/dev/null | tail -n1 || true)"
if [[ -z $addr ]]; then
  echo "the api service publishes no loopback port; cannot verify health" >&2
  exit 8
fi
# The API rejects every /api/* request that lacks the Worker's private gateway
# header, so a bare loopback probe gets a 403 even when the container is healthy.
# Present the same secret the Worker injects; only skip it when the stack itself
# has no EDGE_GATEWAY_TOKEN configured (local development).
gateway_token="$(sed -n 's/^EDGE_GATEWAY_TOKEN=//p' "$env_file" | tail -n1)"
gateway_token="${gateway_token%\"}"
gateway_token="${gateway_token#\"}"
probe=(-fsS --max-time 3)
if [[ -n $gateway_token ]]; then
  probe+=(-H "X-Tasklutein-Gateway: $gateway_token")
fi
delay=$((SECONDS + 90))
healthy=0
while (( SECONDS < delay )); do
  if curl "${probe[@]}" "http://$addr/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ $healthy -eq 0 ]]; then
  echo "api did not answer http://$addr/api/health within 90s" >&2
  echo "a 403 here means EDGE_GATEWAY_TOKEN in deploy/.env does not match the injected header" >&2
  "${compose[@]}" ps >&2
  exit 8
fi
# /api/health is a liveness probe and never touches PostgreSQL, so the database
# is verified separately through the API container's own engine.
if ! "${compose[@]}" exec -T api python - <<'PY' >/dev/null 2>&1
import os

from sqlalchemy import create_engine, text

engine = create_engine(os.environ["DATABASE_URL"])
with engine.connect() as connection:
    connection.execute(text("SELECT 1"))
PY
then
  echo "PostgreSQL is not reachable from the api container" >&2
  exit 8
fi

step="done"
"${compose[@]}" ps
printf '\napi/mcp before this deploy: %s\n' "$prev_images"
echo "verify the public entrypoint through the Worker; Cloudflare was not touched"
