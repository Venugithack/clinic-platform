# Jayamurugan Clinic

Tablet-first operations software for one clinic: patient registration, queue,
vitals, consultations, prescriptions, billing, observation beds, pharmacy
inventory, purchasing, stock-take, registers, and WhatsApp messaging.

## Architecture

This repository contains two separately deployed applications:

| Part | Location | Runtime | Deployment |
|---|---|---|---|
| Web application | `app/`, `components/`, `lib/` | Next.js 16 static export | Cloudflare static assets |
| Clinic backend | `supabase/functions/` | Deno Edge Functions | Supabase |
| Database schema | `supabase/migrations/` | PostgreSQL, schema `jmc` | Supabase |

The browser sends authenticated requests to `NEXT_PUBLIC_FUNCTIONS_URL`. There
is no Next.js server and there are no Next.js API routes. `next build` writes
the deployable frontend to `out/`.

For the detailed architecture and its trade-offs, read
[docs/README.md](docs/README.md). It is the canonical technical document.

## Repository map

```text
app/                    Next.js route, layout, manifest, and global styles
components/             Application shell, feature workspaces, and UI primitives
lib/                    Browser API client and shared frontend helpers
public/                 Static images, PWA icons, and Cloudflare headers
supabase/functions/     Edge Function endpoints and shared backend modules
supabase/migrations/    Forward-only PostgreSQL migrations
tests/                  Small Node unit-test suite
docs/                   Current architecture and operating notes
archive/                Historical docs and ignored local-only reference material
scripts/                Local maintenance utilities
```

Everything the current application does not depend on is isolated under
[`archive/`](archive/README.md). Tracked history remains visible on GitHub;
database backups, the old SQLite database, prototypes, and environment backups
stay under the gitignored `archive/local/` directory. TypeScript excludes the
entire archive.

## Local setup

Requirements: Node.js 24 and npm.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

> **Live-data warning:** there is currently no local Supabase stack. The value
> of `NEXT_PUBLIC_FUNCTIONS_URL` determines which backend receives requests.
> If it points to the deployed project, actions from localhost change live
> clinic data.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Run the Next.js development server |
| `npm run typecheck` | Type-check the web application |
| `npm test` | Run the unit tests |
| `npm run build` | Build the static export into `out/` |
| `npm run preview` | Serve the built `out/` directory with Wrangler |
| `npm run check` | Run type-checking, tests, and the production build |

The backend is excluded from the frontend `tsconfig.json`. Its independent
check requires Deno:

```bash
deno check --node-modules-dir=none supabase/functions/**/*.ts
```

## Environment

Start from [.env.example](.env.example). The web application requires
`NEXT_PUBLIC_FUNCTIONS_URL`; it is public and embedded into the JavaScript
bundle during `npm run build`.

Supabase injects `SUPABASE_DB_URL` into deployed Edge Functions. Function
secrets such as `CLINIC_SESSION_SECRET` and the `WHATSAPP_*` values must be set
in Supabase; Edge Functions do not read `.env.local` from this repository.

Never commit `.env.local` or anything under `archive/local/`.

## Documentation status

- `docs/README.md` describes the application currently in this repository.
- `docs/INVENTORY.md`, `docs/TABLET.md`, and `docs/WHATSAPP.md` remain useful
  domain references, but policy-sensitive details should be revalidated.
- `archive/docs/` contains earlier build plans, proposals, reviews, hosting
  notes, and handovers. Treat them as historical context, not setup
  instructions.

## Deployment

The two halves deploy independently:

```powershell
npm run build
npx wrangler deploy
```

Deploy database migrations and Edge Functions with the Supabase CLI after
linking the intended project. Deployment is not currently automated by CI.
