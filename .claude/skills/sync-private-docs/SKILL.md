---
name: sync-private-docs
description: Back up or restore the git-ignored docs/private/ directory (planning notes, session records, local-only scratch) by two-way sync with a cloud bucket. Use when asked to back up, sync, push, pull, or restore private docs, and before or after editing anything under docs/private/.
---

# Sync private docs (docs/private/ ⇄ object storage)

`docs/private/` is deliberately git-ignored: local-only planning notes, session records,
and the by-exact-path source index. Git-ignoring it keeps it out of the repository, but
that also keeps it out of every backup. This skill gives it durable, cross-machine storage
without committing it.

```bash
.claude/skills/sync-private-docs/sync-private-docs.sh [--dry-run] [--pull-only | --push-only]
```

Remote layout is `<bucket>/<project>/docs/private/…`, where `<project>` is the repository
directory name, derived automatically. A linked worktree still syncs to the main repo's
prefix rather than a bogus one. One bucket can therefore serve many projects, one prefix
each, and this skill folder is portable — copy it into another repo and it syncs that
repo's own prefix.

## Configuration

`PRIVATE_DOCS_BUCKET` is **required** and has no default. This repository is written as
though it were public (see [AGENTS.md](../../../AGENTS.md)), and a bucket name is exactly
the kind of internal infrastructure detail that rule keeps out of tracked files. Set it in
your shell profile:

```bash
export PRIVATE_DOCS_BUCKET=gs://your-bucket     # Google Cloud Storage
export PRIVATE_DOCS_BUCKET=s3://your-bucket     # Amazon S3
```

Both providers are supported; the script picks one from the URL scheme. `gcloud` or `aws`
must be installed and authenticated. `PRIVATE_DOCS_PROJECT` overrides the derived prefix.

## Steps

1. Run the script. Any working directory works — it resolves paths via `git rev-parse`.
2. If it fails on authentication, tell the user to run `gcloud auth login` or
   `aws configure` themselves, then re-run. Do not attempt a login flow yourself.
3. Report what was pulled and pushed from the script's output.

## Semantics, chosen so nothing is ever lost

- **Never deletes.** A file removed on one side is not removed on the other. Prune by
  hand, on both sides, deliberately.
- **Newest wins.** The skip-if-destination-is-newer behaviour applies in both directions,
  so a stale copy cannot overwrite a fresher one.
- **Union.** A file present on only one side is copied to the other.
- **Pre-pull snapshot.** One lossy case survives that design: the same file edited in two
  places since the last sync — the older edit loses. The local directory is tarred to
  `$TMPDIR` before any download, so a clobber stays recoverable. Enable bucket versioning
  for the same protection on the remote side; `--help` prints the exact commands.

Start with `--dry-run` if you are unsure what will move.
