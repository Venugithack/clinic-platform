<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project documentation

Start every task with `docs/README.md`. Its documentation map identifies the
current source for each kind of work and separates implemented behaviour,
approved policy, planned UI/UX, specialist references, operations, and history.

- Read `docs/UI_UX_PLAN.md` before changing a role workspace or interaction.
- Read `docs/OWNER_POLICY_REGISTER.md` before changing clinic policy.
- Read `docs/SCHEMA_AND_TYPES.md` before changing data or API contracts.
- Read `docs/AGENT_IMPLEMENTATION_BRIEF.md` before implementing a planned slice.
- Use `docs/reference/` for specialist background and `docs/operations/` for
  staging, rollout, and support procedures.

Files under `archive/`, including the local-only
`archive/local/hospital-all-in-one-reference/`, are historical references. Do not
treat them as current implementation instructions unless a current document
explicitly points to a preserved decision or the task is to compare an earlier
design.
