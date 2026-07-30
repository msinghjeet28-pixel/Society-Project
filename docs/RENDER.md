# Deploying to Render

## Why the first deploys failed

Three independent causes, all fixed in the repo now. Worth reading, because two
of them would have recurred.

**1. The service was created by hand, so `render.yaml` was never read.**
The dashboard service is named `Society-Project` (URL `society-project-y7mc`),
while `render.yaml` declares `societyrecord-api`. A service created through
**New → Web Service** ignores the blueprint entirely and uses Render's
auto-detected Node commands. Those cannot work here: this is a pnpm workspace
with no build step, and the packages depend on each other through the
`workspace:*` protocol, which `npm install` does not understand.

**2. There was no root `start` script.** Render's default Node start command is
`npm start`. Even a successful build would have been followed by
`npm error Missing script: "start"`. There is one now.

**3. `render.yaml` declared services whose entrypoints do not exist yet** — the
public renderer (week 4) and the worker (week 5). Deploying the blueprint as it
stood would have failed three of four services and buried the real error. It now
declares only what exists; the rest are commented out with the week they arrive.

Separately, CI was failing for its own reason: `pnpm/action-setup` pinned
`version: 9` while `package.json` pinned `packageManager: pnpm@9.15.9`, and
specifying both is an error. The action config no longer pins a version —
`packageManager` is the single source of truth.

## The fix, whichever path you choose

### Path A — use the blueprint (recommended)

Deletes the guesswork: the blueprint carries the build command, start command,
health check path, database wiring, and every environment variable.

1. Render Dashboard → **Blueprints** → **New Blueprint Instance**
2. Pick `msinghjeet28-pixel/Society-Project`, branch `main`
3. Apply. It creates `societyrecord-api` and `societyrecord-db`.
4. Delete the old hand-made `Society-Project` service so two services are not
   deploying the same commit.

`JWT_SIGNING_KEY` is generated automatically. `SMS_PROVIDER_KEY` is marked
`sync: false`, so Render will ask you for it — leave it blank until DLT
registration clears; `OTP_CHANNEL=manual` covers assisted onboarding until then.

### Path B — keep the existing service

Set these four things in the dashboard, then **Manual Deploy → Clear build cache
& deploy**:

| Setting | Value |
| --- | --- |
| Build Command | `pnpm install --frozen-lockfile` |
| Start Command | `node --experimental-strip-types apps/api/src/server.ts` |
| Health Check Path | `/health` |
| Root Directory | *(leave empty)* |

Then add the environment variables:

| Key | Value |
| --- | --- |
| `NODE_VERSION` | `22.18.0` |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | from your Render Postgres (Internal Database URL) |
| `RUN_MIGRATIONS_ON_BOOT` | `true` |
| `JWT_SIGNING_KEY` | a random string of 32+ characters |
| `OTP_CHANNEL` | `manual` |
| `PG_POOL_MAX` | `5` |
| `LOG_LEVEL` | `info` |

You need a Postgres instance first: **New → Postgres**, version 16. Copy its
*Internal* Database URL (not the external one) into `DATABASE_URL`.

## Verifying a deploy

```bash
curl https://<your-service>.onrender.com/health
```

Expect `{"status":"ok","db":true}`. A `200` with `"db": false` means the service
is up but cannot reach Postgres — check `DATABASE_URL`.

The startup log should contain one of:

```
migrate: applied 3 migration(s)
migrate: schema up to date (3 applied previously)
```

If migrations fail the process exits deliberately rather than serving requests
against a schema it could not migrate — writing half-shaped entries into an
append-only ledger cannot be undone.

## Things to know about the free tier

- **The instance spins down when idle**, so the first request after a quiet spell
  can take 50 seconds or more. Normal, not a bug.
- **Free Postgres expires 30 days after creation** and has no point-in-time
  recovery. Fine for building; it must move to a paid tier before a pilot
  society enters real money.
- **No pre-deploy command.** That is why the API applies migrations at boot,
  under an advisory lock so concurrent boots serialise. On a paid plan, move
  migrations to `preDeployCommand` and set `RUN_MIGRATIONS_ON_BOOT=false` — the
  app should not need DDL rights at runtime.
- **No cron jobs.** The nightly chain verification is commented out in
  `render.yaml` for that reason. Until then, run it by hand:
  `node --experimental-strip-types tools/verify-chains.ts`

## What is deployed, and what is not

The API only. There are no screens yet: the product is an Android app plus the
public proof-page renderer, arriving weeks 4–5. What you can hit today is
`/health`, the one-time-code login endpoints, `/auth/me`, and the people-and-roles
routes.

Setting `DEV_CONSOLE=on` (never in production — it refuses) serves a small
developer console at `/dev` for driving those flows by hand.
