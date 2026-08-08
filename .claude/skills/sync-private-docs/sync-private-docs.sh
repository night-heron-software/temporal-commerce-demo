#!/usr/bin/env bash
#
# sync-private-docs.sh — two-way sync of docs/private/ with Google Cloud Storage.
#
# docs/private/ is deliberately git-ignored: local-only planning notes, validation
# session records, analysis scratch. That keeps it out of the repo but also out of
# every backup — this gives it durable, cross-machine storage without committing it.
#
# Layout: one bucket, one prefix per project, mirroring the repo path:
#
#   gs://nightheron-project-private/<project>/docs/private/...
#
# <project> is the repo directory name, so this script is portable — drop the
# skill folder into any repo and it syncs to that repo's own prefix.
#
# SEMANTICS — chosen so that nothing is ever lost:
#
#   * Never deletes. `--delete-unmatched-destination-objects` is deliberately absent
#     from both directions, so deleting a file on one side never deletes it on the
#     other. Prune by hand, on both sides, on purpose.
#   * Newest wins. `-u/--skip-if-dest-has-newer-mtime` runs in BOTH directions, so a
#     stale copy can never overwrite a fresher one.
#   * Union. A file present on only one side is copied to the other.
#   * Pre-pull snapshot. One lossy case survives that design: the same file edited in
#     two places since the last sync — the older edit loses. The local side is
#     tarred to $TMPDIR before anything is downloaded, so it stays recoverable. For
#     the remote side, turn on object versioning once:
#
#       gcloud storage buckets update gs://nightheron-project-private --versioning
#
# Usage:
#   sync-private-docs.sh [--dry-run] [--pull-only | --push-only]
#
# Env:
#   NIGHTHERON_PRIVATE_BUCKET    override the bucket (default gs://nightheron-project-private)
#   NIGHTHERON_PRIVATE_PROJECT   override the derived project prefix

set -euo pipefail

# Derived from the MAIN repo directory, not the current worktree: linked worktrees
# live under .claude/worktrees/<random-name>/ and would otherwise sync to a bogus
# prefix. --git-common-dir points at the main repo's .git from any worktree.
MAIN_REPO_ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
PROJECT_NAME="${NIGHTHERON_PRIVATE_PROJECT:-$(basename "$MAIN_REPO_ROOT")}"

BUCKET="${NIGHTHERON_PRIVATE_BUCKET:-gs://nightheron-project-private}"
DRY_RUN=""
DO_PULL=1
DO_PUSH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --pull-only) DO_PUSH=0 ;;
    --push-only) DO_PULL=0 ;;
    -h | --help)
      sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1 (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
LOCAL_DIR="$REPO_ROOT/docs/private"
REMOTE="$BUCKET/$PROJECT_NAME/docs/private"

# ── Preflight ────────────────────────────────────────────────────────────────

if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ gcloud not found. Install the Google Cloud SDK, then: gcloud auth login" >&2
  exit 1
fi

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  echo "❌ No active gcloud account. Run: gcloud auth login" >&2
  exit 1
fi

mkdir -p "$LOCAL_DIR"

# Distinguishes "bucket missing / no access" from "prefix not created yet", which is
# the normal first-run state and must not be treated as an error.
if ! gcloud storage ls "$BUCKET" >/dev/null 2>&1; then
  cat >&2 <<EOF
❌ Cannot reach $BUCKET.

If your credentials are stale:   gcloud auth login
If the bucket does not exist:    gcloud storage buckets create $BUCKET --location=us-west1 \\
                                   --uniform-bucket-level-access
Then enable versioning (keeps overwritten revisions recoverable):
                                 gcloud storage buckets update $BUCKET --versioning
EOF
  exit 1
fi

echo "📁 local : $LOCAL_DIR"
echo "☁️  remote: $REMOTE"
[[ -n "$DRY_RUN" ]] && echo "🔍 dry run — nothing will be written"

# ── Pull (remote → local) ────────────────────────────────────────────────────

if [[ "$DO_PULL" == "1" ]]; then
  if gcloud storage ls "$REMOTE" >/dev/null 2>&1; then
    # Snapshot before any download, so a concurrent-edit clobber stays recoverable.
    if [[ -n "$(ls -A "$LOCAL_DIR" 2>/dev/null)" && -z "$DRY_RUN" ]]; then
      SNAPSHOT="${TMPDIR:-/tmp}/${PROJECT_NAME}-docs-private-$(date +%Y%m%d-%H%M%S).tgz"
      tar -czf "$SNAPSHOT" -C "$LOCAL_DIR" .
      echo "🛟 pre-pull snapshot: $SNAPSHOT"
    fi
    echo "⬇️  pulling…"
    gcloud storage rsync --recursive --skip-if-dest-has-newer-mtime $DRY_RUN "$REMOTE" "$LOCAL_DIR"
  else
    echo "⬇️  pull skipped — no remote prefix yet (first sync for this project)"
  fi
fi

# ── Push (local → remote) ────────────────────────────────────────────────────

if [[ "$DO_PUSH" == "1" ]]; then
  if [[ -z "$(ls -A "$LOCAL_DIR" 2>/dev/null)" ]]; then
    echo "⬆️  push skipped — $LOCAL_DIR is empty"
  else
    echo "⬆️  pushing…"
    gcloud storage rsync --recursive --skip-if-dest-has-newer-mtime $DRY_RUN "$LOCAL_DIR" "$REMOTE"
  fi
fi

echo "✅ done"
