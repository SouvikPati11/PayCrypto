# Hostinger Startup Fix — "App did not call listen() within 3 seconds"

## Root cause (verified in the GitHub code)

In the old `server/index.js`, startup was:

```js
initDeriver().finally(() => {
  app.listen(config.port, () => console.log(...));
});
```

`initDeriver()` awaited `store.getSetting('wallet_xpub')` — a MySQL
query — before `app.listen()` was ever called. If MySQL was
unavailable, slow, or misconfigured, the HTTP listener was delayed
past Hostinger's 3-second limit and Hostinger killed the app with
"App did not call listen() within 3 seconds", even though the app
code itself was otherwise fine. The public pages and `/health`
could not answer at all, because the process never got a port.

## The fix (this commit, no other behaviour changed)

Startup order is now strictly:

1. Build the Express app (synchronous, no I/O).
2. Call `app.listen(PORT, '0.0.0.0')` **immediately**, using the
   Hostinger-provided `process.env.PORT` (falling back to 3000
   only if PORT is missing/invalid, with a log line saying so).
   Measured locally: **20 ms** to listen with MySQL down,
   **35 ms** with a memory store — both far under 3 seconds.
3. Only after the listener is up, run the database ping and HD
   deriver asynchronously in the background, with a 30-second
   retry (unref'd) if they fail. A failure is logged and reported,
   but it never crashes the HTTP server.

Other startup behaviour, unchanged:
- Gates stay off: `PAYMENTS_LIVE=false`, `AUTO_SWEEP=false`,
  `WITHDRAWAL_AUTO_BROADCAST=false`.
- CSP, CSRF, session handling, routes, ledger, signer service,
  and all other features are untouched.
- The production-secrets check (`JWT_SECRET` / `SESSION_SECRET`
  ≥32 chars, `ENCRYPTION_KEY` 64 hex) is still synchronous and
  still exits before listen if it fails — that check takes
  <1 ms and is not a network wait, so it cannot cause the
  3-second failure. If Hostinger logs show that error, fix the
  production secrets in hPanel; it is not a MySQL problem.

## Honest health and readiness (no false positives)

- `GET /health` — liveness only. It always answers HTTP 200 when
  the process is up, but it reports the real state:
  `status: 'ready' | 'starting' | 'degraded'`,
  `db_ready: true/false`, `db: 'unknown' | 'ready' | 'unavailable'`,
  `deriver: 'pending' | 'ready' | 'not_configured' | 'failed'`,
  and `last_error` as an error **code only** (e.g. `ECONNREFUSED`).
  It never claims the database is ready when it is not, and it
  never includes a password, connection string or full internal
  message.
- `GET /ready` — strict readiness. HTTP 200 only when the database
  is actually reachable; otherwise HTTP 503 with
  `message: 'Database unavailable'`. Use this for load-balancer /
  uptime checks that should only pass when DB traffic can work.
- API routes: if the database is known unavailable (checked within
  the last 30 seconds), they fail fast with HTTP 503
  `Database unavailable` instead of waiting for another slow DB
  timeout. DB errors in route error handlers are mapped to 503
  the same way. Static pages and `/health` / `/ready` stay
  available while the DB is down.
- No silent memory fallback in production: `MEMORY_DB=true` with
  `NODE_ENV=production` now throws at store creation
  ("MEMORY_DB must not be used in production") instead of
  silently running an in-memory store that loses data on restart.
  In development / tests, `MEMORY_DB=true` is still explicit.

## Separate MySQL diagnosis (not fixed by this change)

This fix guarantees the app **starts** without MySQL. It does not
fix a broken MySQL configuration — if `/health` shows
`db: 'unavailable'`, check these in hPanel, in order, without
sharing credentials in chat:

1. **Database exists and the app user can reach it:** hPanel →
   Databases — confirm the database name, username and host
   exactly match the app's `.env` (`DB_HOST`, `DB_PORT`,
   `DB_USER`, `DB_NAME`). A typo here is the most common cause.
2. **User privileges:** the app user must have SELECT, INSERT,
   UPDATE, DELETE, CREATE, ALTER, INDEX on that database.
3. **Migrations imported:** `001_schema.sql` then `002_seed.sql`
   (see `docs/DEPLOYMENT_CHECKLIST.md`). A missing
   `system_settings` table makes the deriver ping fail with a
   MySQL error code, not a connection error — check `/health`
   `last_error` to tell the two apart.
4. **Host / port:** on Hostinger shared hosting, `DB_HOST` is
   usually `localhost`. A remote host or a wrong port gives
   `ECONNREFUSED` / `ETIMEDOUT` in `/health`.
5. **Secrets:** if the app exits before logging
   `[startup] PayCrypto listening…`, read the log for the
   production-secrets error above — that is not a DB problem.

## How to verify on Hostinger after deploying this fix

1. Deploy, then check the app logs for:
   `[startup] PayCrypto listening on 0.0.0.0:<PORT> after <…>ms`
   — the time must be well under 3,000 ms.
2. Open `https://<your-domain>/health` — it must answer even if
   the DB is still being fixed, with `status` and `db` showing
   the real state.
3. Open `https://<your-domain>/ready` — it must be 200 only once
   MySQL is reachable and migrations are imported.
4. Fix MySQL using the checklist above until `/ready` is 200,
   then log in and confirm a pending merchant still cannot create
   invoices until approved (unchanged behaviour).

## Tests

5 new Hostinger tests, all passing locally (full suite 39/39):
- DB-error → 503 mapping (and non-DB errors stay non-503).
- Production + `MEMORY_DB` refuses to create a store.
- Memory-store app: `/health` ready, `/ready` 200, deriver
  honestly `not_configured` when no xpub is set.
- Child-process, MySQL down (closed port): `/health` in <3 s,
  `db: 'unavailable'`, `last_error: 'ECONNREFUSED'`,
  `/ready` 503, `/api/auth/login` 503 fast, no password in
  `/health` or logs.
- Child-process, MySQL hanging (dummy TCP server that never
  responds): `/health` in <3 s with `db: 'unknown'`
  (honest, not ready), `/ready` 503.

Node compatibility: `engines: >=20` in `package.json`, no
Node-22-only APIs are used by this fix. Verified on Node 24
locally; the code path is the same on Node 20.

## Update 2 — entry-file architecture (2026-11-05, second Hostinger failure mode)

Hostinger's runtime logs warned the entry file may be loaded without
`require.main === module` being true. The previous fix still guarded
startup with `if (require.main === module)`, so in that loading mode
`startServer()` was never called at all — a second, independent cause
of "App did not call listen() within 3 seconds".

Architecture now:
- `server/index.js` — the Hostinger startup file. It starts the
  server **unconditionally**: `assertProductionSecrets();`
  then `startServer();`. There is no `require.main` guard anywhere
  in the entry code. `package.json` `main` and `start` still point
  at `server/index.js`, so `node server/index.js` works unchanged.
- `server/app.js` — all app construction and route registration
  (moved from the old `index.js`, otherwise unchanged).
  Importing `server/app.js` does NOT start a server, so tests can
  import the app without accidentally starting a production server.
  `server/index.js` re-exports it for any loader that needs the app.
- `startServer()` starts only once per process: a second call
  returns the existing server instead of listening again
  (which would fail with EADDRINUSE).
- Order preserved: secrets check → immediate `app.listen(PORT,
  '0.0.0.0')` → async DB readiness + deriver after listen.
  Weak production secrets still exit 1 before any listening.

Verified, not just read from source:
- Direct `node server/index.js` and loader-required
  `server/index.js` (where `require.main !== module`) both listen
  in ~15–23 ms and answer `/health` — on **Node 20.19.0 and
  Node 24.22.1**.
- Regression test in the suite: a loader script in a temp dir
  requires `server/index.js` and asserts `/health` in <3 s.
- Start-once test: two `startServer()` calls return the same
  server object.
- Full suite: 41/41 pass.
