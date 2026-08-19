#!/usr/bin/env bash
#
# sync-private-docs.sh — two-way sync of docs/private/ with cloud object storage.
#
# docs/private/ is deliberately git-ignored: local-only planning notes, session
# records, analysis scratch. That keeps it out of the repository but also out of every
# backup — this gives it durable, cross-machine storage without committing it.
#
# Layout: one bucket, one prefix per project, mirroring the repo path:
#
#   <bucket>/<project>/docs/private/...
#
# <project> is the repo directory name, so this script is portable — drop the skill
# folder into any repo and it syncs to that repo's own prefix.
#
# The bucket is NOT hardcoded. This repository is written as though it were public
# (see AGENTS.md), and an internal bucket name is exactly the kind of infrastructure
# detail that rule exists to keep out. Set PRIVATE_DOCS_BUCKET in your shell profile.
#
# SEMANTICS — chosen so that nothing is ever lost:
#
#   * Never deletes. The delete flag is deliberately absent from both directions, so
#     deleting a file on one side never deletes it on the other. Prune by hand, on
#     both sides, on purpose.
#   * Newest wins. The skip-if-newer flag runs in BOTH directions, so a stale copy can
#     never overwrite a fresher one.
#   * Union. A file present on only one side is copied to the other.
#   * Pre-pull snapshot. One lossy case survives that design: the same file edited in
#     two places since the last sync — the older edit loses. The local side is tarred
#     to $TMPDIR before anything is downloaded, so it stays recoverable. For the remote
#     side, turn on object versioning once (see --help output).
#
# SKILL BACKUP: a snapshot of this project's Claude skill is refreshed into
# docs/private/skill-backup/ before each sync, so the bucket carries the current skill —
# the live file lives outside every repo and is otherwise backed up by nothing. The live
# copy is authoritative; restoring FROM the backup is deliberately manual (the script
# warns when a pulled backup differs from the live skill, and stops there).
#
# Which skills, in precedence order:
#   1. $PRIVATE_DOCS_SKILLS          space-separated names (one-off override)
#   2. .claude/private-docs-skills   one name per line, committed with the repo
#   3. $HOME/.claude/skills/<project>/SKILL.md, when the skill is named for the repo
#
# The override exists because a skill is named for the work it covers, not for one of
# the repos that work touches. A skill spanning several repos of one effort is correctly
# named after the effort, so matching it by repo name finds nothing — and renaming the
# skill to satisfy a backup script would be backwards. The script learns the pointer
# instead, and the pointer lives in the repo so it cannot be forgotten.
#
# Usage:
#   sync-private-docs.sh [--dry-run] [--pull-only | --push-only]
#
# Env:
#   PRIVATE_DOCS_BUCKET    required; gs://... for GCS or s3://... for S3
#   PRIVATE_DOCS_PROJECT   override the derived project prefix
#   PRIVATE_DOCS_SKILLS    space-separated skill names to back up (see above)

set -euo pipefail

DRY_RUN=""
DO_PULL=1
DO_PUSH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --pull-only) DO_PUSH=0 ;;
    --push-only) DO_PULL=0 ;;
    -h | --help)
      sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1 (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

# ── Configuration ────────────────────────────────────────────────────────────

if [[ -z "${PRIVATE_DOCS_BUCKET:-}" ]]; then
  cat >&2 <<'EOF'
❌ PRIVATE_DOCS_BUCKET is not set.

This script does not hardcode a bucket — see the note at the top of the file.
Set it in your shell profile, using whichever provider you use:

  export PRIVATE_DOCS_BUCKET=gs://your-bucket      # Google Cloud Storage
  export PRIVATE_DOCS_BUCKET=s3://your-bucket      # Amazon S3

First-time bucket setup, with versioning so overwritten revisions stay recoverable:

  GCS:  gcloud storage buckets create gs://your-bucket --location=us-west1 \
          --uniform-bucket-level-access
        gcloud storage buckets update gs://your-bucket --versioning

  S3:   aws s3 mb s3://your-bucket
        aws s3api put-bucket-versioning --bucket your-bucket \
          --versioning-configuration Status=Enabled
EOF
  exit 1
fi

BUCKET="${PRIVATE_DOCS_BUCKET%/}"

case "$BUCKET" in
  gs://*) PROVIDER="gcs" ;;
  s3://*) PROVIDER="s3" ;;
  *)
    echo "❌ PRIVATE_DOCS_BUCKET must start with gs:// or s3:// (got: $BUCKET)" >&2
    exit 1
    ;;
esac

# Derived from the MAIN repo directory, not the current worktree: linked worktrees live
# under .claude/worktrees/<name>/ and would otherwise sync to a bogus prefix.
MAIN_REPO_ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
PROJECT_NAME="${PRIVATE_DOCS_PROJECT:-$(basename "$MAIN_REPO_ROOT")}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
LOCAL_DIR="$REPO_ROOT/docs/private"
REMOTE="$BUCKET/$PROJECT_NAME/docs/private"

# ── Preflight ────────────────────────────────────────────────────────────────

if [[ "$PROVIDER" == "gcs" ]]; then
  command -v gcloud >/dev/null 2>&1 || {
    echo "❌ gcloud not found. Install the Google Cloud SDK, then: gcloud auth login" >&2
    exit 1
  }
  gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q . || {
    echo "❌ No active gcloud account. Run: gcloud auth login" >&2
    exit 1
  }
else
  command -v aws >/dev/null 2>&1 || {
    echo "❌ aws not found. Install the AWS CLI, then: aws configure" >&2
    exit 1
  }
  aws sts get-caller-identity >/dev/null 2>&1 || {
    echo "❌ No valid AWS credentials. Run: aws configure (or set AWS_PROFILE)" >&2
    exit 1
  }
fi

mkdir -p "$LOCAL_DIR"

# Distinguishes "bucket missing / no access" from "prefix not created yet", which is the
# normal first-run state and must not be treated as an error.
# Capture the provider's own error rather than discarding it. An expired token and a
# missing bucket both fail here, and they need different fixes — a generic "cannot reach"
# message sends you looking in the wrong place. The account-is-configured check above
# cannot tell them apart either: credentials can be present but stale.
probe_output=""
if [[ "$PROVIDER" == "gcs" ]]; then
  probe_output="$(gcloud storage ls "$BUCKET" 2>&1 >/dev/null)" || probe_failed=1
else
  probe_output="$(aws s3 ls "$BUCKET" 2>&1 >/dev/null)" || probe_failed=1
fi

if [[ -n "${probe_failed:-}" ]]; then
  echo "❌ Cannot reach $BUCKET." >&2
  echo >&2
  echo "${probe_output}" | sed 's/^/   /' >&2
  echo >&2
  if echo "${probe_output}" | grep -qiE "reauth|credential|token|denied|forbidden|login"; then
    echo "   This looks like an authentication problem. Run the login command above" >&2
    echo "   yourself, then re-run this script." >&2
  else
    echo "   If the bucket does not exist yet, --help prints the create commands." >&2
  fi
  exit 1
fi

remote_exists() {
  if [[ "$PROVIDER" == "gcs" ]]; then
    gcloud storage ls "$REMOTE" >/dev/null 2>&1
  else
    [[ -n "$(aws s3 ls "$REMOTE/" 2>/dev/null)" ]]
  fi
}

sync_dir() {
  local src="$1" dest="$2"
  if [[ "$PROVIDER" == "gcs" ]]; then
    # shellcheck disable=SC2086
    gcloud storage rsync --recursive --skip-if-dest-has-newer-mtime $DRY_RUN "$src" "$dest"
  else
    # s3 sync skips files whose destination copy is newer by default, and without
    # --delete it never removes — the same semantics as the GCS branch above.
    # shellcheck disable=SC2086
    aws s3 sync $DRY_RUN "$src" "$dest"
  fi
}

echo "📁 local : $LOCAL_DIR"
echo "☁️  remote: $REMOTE  ($PROVIDER)"
[[ -n "$DRY_RUN" ]] && echo "🔍 dry run — nothing will be written"

# ── Skill backup refresh (live skills → docs/private) ────────────────────────
# Runs BEFORE the pull so newest-wins compares honest timestamps: `cp -p` carries each
# live skill's own mtime onto its snapshot, so a genuinely newer backup from another
# machine still wins the pull, and the check after the pull flags it.
#
# Named skills override the project-name default; a name that has no skill on this
# machine is reported rather than skipped silently, since a typo here backs up nothing.
#
# Precedence: the env var (one-off), then a repo-local config file (durable, committed
# with the repo), then the project-name default. The file matters more than it looks:
# an override that lives only in someone's shell is the same "remember to do it"
# failure this whole backup step exists to remove.
SKILLS_CONFIG="$REPO_ROOT/.claude/private-docs-skills"
SKILL_NAMES=()
if [[ -n "${PRIVATE_DOCS_SKILLS:-}" ]]; then
  read -r -a SKILL_NAMES <<<"$PRIVATE_DOCS_SKILLS"
elif [[ -f "$SKILLS_CONFIG" ]]; then
  # One name per line; blank lines and # comments ignored.
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(echo "$line" | tr -d '[:space:]')"
    [[ -n "$line" ]] && SKILL_NAMES+=("$line")
  done <"$SKILLS_CONFIG"
elif [[ -f "$HOME/.claude/skills/$PROJECT_NAME/SKILL.md" ]]; then
  SKILL_NAMES=("$PROJECT_NAME")
fi

skill_live_path() { echo "$HOME/.claude/skills/$1/SKILL.md"; }
skill_backup_path() { echo "$LOCAL_DIR/skill-backup/$1-SKILL.md"; }

if [[ "$DO_PUSH" == "1" ]]; then
  for name in "${SKILL_NAMES[@]:-}"; do
    [[ -z "$name" ]] && continue
    live="$(skill_live_path "$name")"
    backup="$(skill_backup_path "$name")"

    if [[ ! -f "$live" ]]; then
      echo "⚠️  no skill at $live (named in PRIVATE_DOCS_SKILLS) — nothing to back up"
      continue
    fi
    if cmp -s "$live" "$backup" 2>/dev/null; then
      continue # snapshot already current
    fi
    if [[ -n "$DRY_RUN" ]]; then
      echo "🧰 would refresh skill backup: $name"
    else
      mkdir -p "$(dirname "$backup")"
      cp -p "$live" "$backup"
      echo "🧰 refreshed skill backup: $name"
    fi
  done
fi

# ── Pull (remote → local) ────────────────────────────────────────────────────

if [[ "$DO_PULL" == "1" ]]; then
  if remote_exists; then
    # Snapshot before any download, so a concurrent-edit clobber stays recoverable.
    if [[ -n "$(ls -A "$LOCAL_DIR" 2>/dev/null)" && -z "$DRY_RUN" ]]; then
      SNAPSHOT="${TMPDIR:-/tmp}/${PROJECT_NAME}-docs-private-$(date +%Y%m%d-%H%M%S).tgz"
      tar -czf "$SNAPSHOT" -C "$LOCAL_DIR" .
      echo "🛟 pre-pull snapshot: $SNAPSHOT"
    fi
    echo "⬇️  pulling…"
    sync_dir "$REMOTE" "$LOCAL_DIR"

    # The pull can legitimately bring down a skill backup another machine refreshed more
    # recently than this machine's live skill. Restoring into $HOME is deliberately NOT
    # automated — flag it and leave the decision to a human.
    #
    # Content comparison, not mtime: object-store mtimes reflect upload provenance, not
    # edits, and an mtime-only check cried wolf on a byte-identical backup on this
    # script's very first pull.
    for name in "${SKILL_NAMES[@]:-}"; do
      [[ -z "$name" ]] && continue
      live="$(skill_live_path "$name")"
      backup="$(skill_backup_path "$name")"
      if [[ -f "$backup" && -f "$live" ]] && ! cmp -s "$backup" "$live"; then
        echo "⚠️  pulled backup of skill '$name' differs from the live copy at $live"
        echo "    (another machine likely updated it — review and copy back by hand)"
      fi
    done
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
    sync_dir "$LOCAL_DIR" "$REMOTE"
  fi
fi

echo "✅ done"
