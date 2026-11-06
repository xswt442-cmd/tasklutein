#!/usr/bin/env bash
# Keep a Preview stack on the Docker host in step with the remote `dev` branch.
#
# Runs from a systemd timer on the host that owns the Preview Compose project.
# It holds no secret and accepts no inbound connection: every tick it fetches
# the branch, compares the fetched commit with the one it last deployed, and
# only then resets the checkout and calls scripts/deploy-backend.sh.
#
# The checkout it runs in is MANAGED: local commits, stashes and untracked files
# are discarded on every deploy. Ignored files (deploy/.env.preview) are kept.
#
# Environment (all optional):
#   PREVIEW_BRANCH        remote branch to follow   (default: dev)
#   PREVIEW_PROJECT       Compose project           (default: tasklutein-preview)
#   PREVIEW_ENV_FILE      Compose env file          (default: deploy/.env.preview)
#   PREVIEW_COMPOSE_FILE  Compose file              (default: deploy/compose.yml)
#
# Exit codes: 0 nothing to do or deployed, 2 usage, 3 not a git checkout,
#             otherwise the scripts/deploy-backend.sh status.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/preview-autodeploy.sh [--force]

  --force  Deploy the current remote head even if it was already deployed or
           failed last time.

Fetch failures are not reported as failures: the timer retries on the next run.
A failed deploy is remembered for its commit and is not retried until the
branch moves, so a broken commit does not rebuild every tick.
EOF
}

force=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$repo_root"

branch="${PREVIEW_BRANCH:-dev}"
project="${PREVIEW_PROJECT:-tasklutein-preview}"
env_file="${PREVIEW_ENV_FILE:-deploy/.env.preview}"
compose_file="${PREVIEW_COMPOSE_FILE:-deploy/compose.yml}"

git -C "$repo_root" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "not a git checkout: $repo_root" >&2
  exit 3
}

# State lives inside .git so it can never be committed and survives the reset.
state_dir="$repo_root/.git/tasklutein-autodeploy"
mkdir -p -- "$state_dir"
last_ok="$state_dir/last-deployed-$branch"
last_failed="$state_dir/last-failed-$branch"

if ! timeout 180 git fetch --quiet --prune origin \
  "+refs/heads/$branch:refs/remotes/origin/$branch"; then
  echo "could not fetch origin/$branch; the next run will retry" >&2
  exit 0
fi

target="$(git rev-parse "origin/$branch")"
deployed="$(cat -- "$last_ok" 2>/dev/null || true)"
failed="$(cat -- "$last_failed" 2>/dev/null || true)"

if (( force == 0 )) && [[ $target == "$deployed" ]]; then
  echo "origin/$branch is already deployed at ${target:0:7}"
  exit 0
fi
if (( force == 0 )) && [[ $target == "$failed" && $target != "$deployed" ]]; then
  echo "the last deploy of ${target:0:7} failed; push a new commit or pass --force" >&2
  exit 0
fi

echo "deploying ${target:0:7} (origin/$branch), previously ${deployed:0:7}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "discarding local changes in the managed checkout"
fi
# Clean before checkout: an untracked file that the target commit tracks would
# otherwise block the switch. Ignored files (the env file) are never removed.
git clean -fdq
git checkout --quiet --force -B "$branch" "$target"

status=0
bash "$repo_root/scripts/deploy-backend.sh" \
  --project "$project" \
  --env-file "$env_file" \
  --compose-file "$compose_file" || status=$?

if (( status == 0 )); then
  printf '%s\n' "$target" >"$last_ok"
  rm -f -- "$last_failed"
  # Every rebuild leaves the previous api/mcp layers untagged; without this the
  # host accumulates a few hundred MB per deploy.
  docker image prune -f >/dev/null 2>&1 || true
  echo "origin/$branch is now deployed at ${target:0:7}"
  exit 0
fi

if (( status == 3 )); then
  # A concurrent deploy holds the lock, or the checkout failed preflight.
  echo "deploy did not start (exit 3); the next run will retry" >&2
  exit 0
fi

printf '%s\n' "$target" >"$last_failed"
echo "deploy of ${target:0:7} failed with exit $status" >&2
exit "$status"
