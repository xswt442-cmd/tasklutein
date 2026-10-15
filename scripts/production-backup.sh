#!/usr/bin/env bash
# Run on the Tencent host as the normal Docker-enabled maintainer account.
# Logical snapshot only: does not stop PostgreSQL or touch its data volume.
set -euo pipefail
umask 077

if (( $# != 0 )); then
  echo "Usage: bash scripts/production-backup.sh (run on the Tencent host)" >&2
  exit 2
fi

db_container="deploy-db-1"
backup_dir="$HOME/backups/tasklutein-production"
image_status="$(docker inspect "$db_container" --format '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}')"
if [[ "$image_status" != "deploy|db" ]]; then
  echo "Refusing backup: expected the Production deploy/db container" >&2
  exit 3
fi

docker exec "$db_container" pg_isready -U tasklutein -d tasklutein >/dev/null
mkdir -p -- "$backup_dir"
chmod 700 -- "$backup_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot="$backup_dir/tasklutein-production-$stamp.dump"
[[ ! -e "$snapshot" ]] || { echo "Refusing to overwrite an existing snapshot" >&2; exit 4; }
partial="$(mktemp "$backup_dir/.tasklutein-production.XXXXXXXX.partial")"
trap 'rm -f -- "$partial"' EXIT

docker exec "$db_container" pg_dump --format=custom --no-owner --no-acl \
  -U tasklutein -d tasklutein > "$partial"
[[ -s "$partial" ]] || { echo "Refusing empty snapshot" >&2; exit 5; }
docker exec -i "$db_container" pg_restore --list < "$partial" >/dev/null
chmod 600 "$partial"

# Atomic hardlink creation refuses a second writer to the same timestamp.
ln -- "$partial" "$snapshot"
rm -f -- "$partial"
trap - EXIT

sha256sum -- "$snapshot" > "$snapshot.sha256"
chmod 600 -- "$snapshot.sha256"

printf 'SNAPSHOT=%s\nSIZE_BYTES=%s\nMODE=%s\nCHECKSUM=' \
  "$snapshot" "$(stat -c %s "$snapshot")" "$(stat -c %a "$snapshot")"
sha256sum "$snapshot" | cut -d ' ' -f1
echo "This is an on-host snapshot, not an off-host disaster-recovery backup."
