# Archive

Nothing under this directory is imported, built, tested, deployed, or read at
runtime by the current clinic application. TypeScript excludes `archive/`, and
Git ignores `archive/local/`.

## Tracked history

- `docs/` contains superseded plans, proposals, reviews, and handovers.
- `github-workflows/backup.yml` is the disabled backup workflow. It cannot run
  because the shell scripts it called no longer exist.

These files remain on GitHub for context, but they are not current operating
instructions.

## Local-only material

`local/` is intentionally absent from GitHub because it contains large,
sensitive, or machine-specific material:

- `previous-hospital-project/` — the earlier standalone project, including its
  own Git history, dependencies, and build output.
- `ui-concept/` — static HTML mockups.
- `legacy-sqlite/` — the database used before PostgreSQL.
- `database-backups/` — old local database dumps.
- `environment/` — environment-file backups.

The current app is unaffected if any of these paths are moved elsewhere or
removed. Deleting them is still permanent: it discards historical source,
recovery copies, or credentials. Keep any backup you may need, and handle the
database and environment files as sensitive clinic data.

Generated directories for the current app (`node_modules/`, `.next/`, `out/`,
and `.wrangler/`) remain at the repository root because tools recreate and use
them during normal development; they are gitignored rather than archived.
