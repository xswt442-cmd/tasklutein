#!/usr/bin/env bash
# Safe restore rehearsal in a disposable, network-isolated, RAM-backed PostgreSQL.
# Never targets the existing Production PostgreSQL container or data volume.
set -euo pipefail
umask 077

if (( $# != 1 )); then
  echo "Usage: bash scripts/production-restore-check.sh /absolute/path/to/snapshot.dump" >&2
  exit 2
fi

backup_dir="$(realpath "$HOME/backups/tasklutein-production")"
snapshot="$(realpath -- "$1")"
case "$snapshot" in
  "$backup_dir"/tasklutein-production-*.dump) ;;
  *) echo "Refusing backup outside dedicated Production backup directory" >&2; exit 3 ;;
esac
[[ -f "$snapshot" && -f "$snapshot.sha256" ]] || { echo "Snapshot or checksum missing" >&2; exit 4; }
sha256sum -c -- "$snapshot.sha256" >/dev/null

image="postgres:17-alpine"
docker image inspect "$image" >/dev/null
name="tasklutein-restorecheck-$(date -u +%H%M%S)-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# trust auth is restricted to a network-less, ephemeral container.
docker run -d --rm --name "$name" --network none \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null

# initdb briefly starts then stops a bootstrap PostgreSQL; wait for FINAL start.
attempt=0
until [[ "$(docker logs "$name" 2>&1 | grep -c 'database system is ready to accept connections' || true)" -ge 2 ]] &&
  docker exec "$name" psql -U postgres -d postgres -At -c 'SELECT 1' 2>/dev/null | grep -qx 1; do
  attempt=$((attempt + 1))
  if (( attempt > 40 )); then
    echo "Isolated PostgreSQL failed to finish startup" >&2
    exit 5
  fi
  sleep 1
done

docker cp "$snapshot" "$name:/tmp/restore.dump"
docker exec "$name" pg_restore --exit-on-error --no-owner --no-acl \
  -U postgres -d postgres /tmp/restore.dump

tables="$(docker exec "$name" psql -U postgres -d postgres -At -c \
  "SELECT string_agg(tablename,',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public'")"
[[ "$tables" == "reports,tasks" ]] || { echo "Unexpected restored tables" >&2; exit 6; }
counts="$(docker exec "$name" psql -U postgres -d postgres -At -c \
  "SELECT 'tasks='||(SELECT count(*) FROM public.tasks)||',reports='||(SELECT count(*) FROM public.reports)")"

echo "RESTORE=PASS network=none storage=tmpfs tables=$tables $counts"
echo "The disposable restore container is automatically removed on exit."
