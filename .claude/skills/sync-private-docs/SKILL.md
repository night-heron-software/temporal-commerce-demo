---
name: sync-private-docs
description: Back up / restore the git-ignored docs/private/ (planning notes, validation session records) via two-way sync with the GCS bucket gs://nightheron-project-private. Use when asked to back up, sync, push, pull, or restore private docs, or before/after editing anything under docs/private/.
---

# Sync private docs (docs/private/ ⇄ GCS)

`docs/private/` is deliberately git-ignored: local-only planning notes, validation
session records, analysis scratch. This skill gives it durable, cross-machine
storage without committing it. The sync script lives in this skill's directory:

```bash
.claude/skills/sync-private-docs/sync-private-docs.sh [--dry-run] [--pull-only | --push-only]
```

Remote layout: `gs://nightheron-project-private/<project>/docs/private/...` where
`<project>` is the repo directory name, derived automatically (worktree-safe: a
linked worktree under `.claude/worktrees/` still syncs to the main repo's prefix).
One bucket is shared across all Night Heron projects, one prefix each — so this
skill folder is portable: copy it into any repo and it syncs that repo's own prefix.

## Steps

1. Run the script (any working directory works — it resolves paths via `git rev-parse`).
2. If it fails on auth, tell the user to run `gcloud auth login` themselves, then
   re-run. Do not attempt the login flow yourself.
3. Report what was pulled and pushed from the script's output.

## Semantics (chosen so nothing is ever lost)

- **Never deletes** — a file deleted on one side is NOT deleted on the other;
  prune by hand, on both sides, on purpose.
- **Newest wins** — `--skip-if-dest-has-newer-mtime` runs in both directions, so a
  stale copy never overwrites a fresher one.
- **Union** — a file present on only one side is copied to the other.
- **Pre-pull snapshot** — before any download, the local dir is tarred to `$TMPDIR`
  so a concurrent-edit clobber stays recoverable. The remote side relies on bucket
  object versioning.

## Flags & env

- `--dry-run` — show what would transfer, write nothing. Use this first if unsure.
- `--pull-only` / `--push-only` — one direction only (e.g. `--pull-only` on a fresh
  clone, `--push-only` to back up without risking local overwrites).
- `NIGHTHERON_PRIVATE_BUCKET` — override the bucket.
- `NIGHTHERON_PRIVATE_PROJECT` — override the derived project prefix.

## First-run bucket setup (only if the bucket is missing)

```bash
gcloud storage buckets create gs://nightheron-project-private --location=us-west1 --uniform-bucket-level-access
gcloud storage buckets update gs://nightheron-project-private --versioning
```
