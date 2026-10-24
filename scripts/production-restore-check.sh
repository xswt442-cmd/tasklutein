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

version_table_exists="$(docker exec "$name" psql -U postgres -d postgres -At -c \
  "SELECT to_regclass('public.alembic_version') IS NOT NULL")"
if [[ "$version_table_exists" == "t" ]]; then
  revision="$(docker exec "$name" psql -U postgres -d postgres -At -c \
    'SELECT version_num FROM public.alembic_version')"
else
  revision=0001_baseline
fi
case "$revision" in
  0001_baseline)
    if [[ "$version_table_exists" == "t" ]]; then
      required_tables=(alembic_version reports tasks)
    else
      required_tables=(reports tasks)
    fi
    ;;
  0004_task_history)
    required_tables=(activities agent_tokens alembic_version reports tasks users workspaces)
    ;;
  0005_report_comments|0006_agent_token_hard_delete)
    required_tables=(activities agent_tokens alembic_version report_comments reports tasks users workspaces)
    ;;
  0007_team_review_concurrency)
    required_tables=(activities agent_tokens alembic_version report_comments report_reviews reports tasks users workspaces workspace_invitations workspace_members)
    ;;
  *)
    echo "Unsupported restored Alembic revision: $revision" >&2
    exit 6
    ;;
esac

for table in "${required_tables[@]}"; do
  present="$(docker exec "$name" psql -U postgres -d postgres -At -c \
    "SELECT to_regclass('public.$table') IS NOT NULL")"
  [[ "$present" == "t" ]] || { echo "Missing restored table: $table" >&2; exit 7; }
done

case "$revision" in
  0001_baseline)
    counts="$(docker exec "$name" psql -U postgres -d postgres -At -c \
      "SELECT 'tasks='||(SELECT count(*) FROM public.tasks)||',reports='||(SELECT count(*) FROM public.reports)")"
    ;;
  0004_task_history)
    counts="$(docker exec "$name" psql -U postgres -d postgres -At -c \
      "SELECT 'tasks='||(SELECT count(*) FROM public.tasks)||',reports='||(SELECT count(*) FROM public.reports)||',activities='||(SELECT count(*) FROM public.activities)")"
    ;;
  0005_report_comments|0006_agent_token_hard_delete)
    counts="$(docker exec "$name" psql -U postgres -d postgres -At -c \
      "SELECT 'tasks='||(SELECT count(*) FROM public.tasks)||',reports='||(SELECT count(*) FROM public.reports)||',activities='||(SELECT count(*) FROM public.activities)")"
    comments="$(docker exec "$name" psql -U postgres -d postgres -At -c \
      'SELECT count(*) FROM public.report_comments')"
    counts="$counts,comments=$comments"
    ;;
  0007_team_review_concurrency)
    counts="$(docker exec "$name" psql -U postgres -d postgres -At -c \
      "SELECT 'tasks='||(SELECT count(*) FROM public.tasks)||',reports='||(SELECT count(*) FROM public.reports)||',activities='||(SELECT count(*) FROM public.activities)")"
    comments="$(docker exec "$name" psql -U postgres -d postgres -At -c \
      'SELECT count(*) FROM public.report_comments')"
    team_data="$(docker exec "$name" psql -U postgres -d postgres -At -c \
      "SELECT 'workspaces='||(SELECT count(*) FROM public.workspaces WHERE kind = 'team')||',members='||(SELECT count(*) FROM public.workspace_members)||',invitations='||(SELECT count(*) FROM public.workspace_invitations)||',reviews='||(SELECT count(*) FROM public.report_reviews)")"
    counts="$counts,comments=$comments,$team_data"
    ;;
esac

echo "RESTORE=PASS network=none storage=tmpfs revision=$revision required_tables=${required_tables[*]} $counts"
echo "The disposable restore container is automatically removed on exit."
