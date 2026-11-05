# MySQL Authentication Diagnosis — ER_ACCESS_DENIED_ERROR (1045)

## What the error means

`ER_ACCESS_DENIED_ERROR`, errno **1045**, SQL state **28000**:

```
Access denied for user '<user>'@'<host>' (using password: YES|NO)
```

MySQL **reached the server and rejected the login**. It is not a
network error, not a wrong-database-name error, and not a missing
table. The three errors are distinct, and the code tells you which
one you have:

| Error | Code / errno | Meaning |
|---|---|---|
| `ER_ACCESS_DENIED_ERROR` | 1045 / 28000 | Wrong user, wrong password, or user not granted from this host |
| `ER_BAD_DB_ERROR` | 1049 / 42000 | Auth succeeded, but the database name does not exist |
| `ER_HOST_NOT_PRIVILEGED` | 1130 / HY000 | The host is not allowed to connect at all |
| `ECONNREFUSED` / `ETIMEDOUT` | — | MySQL was not reached (wrong host/port, server down) |

So a 1045 narrows the fault to **user / password / host grant** —
never to the schema, migrations, or table contents. No data has
been changed by this failure, and no fix here touches the schema.

## What the code was verified to do

Inspected in the repository (not assumed):

- The app reads exactly five variables, in one place only,
  `server/src/lib/config.js`: `DB_HOST`, `DB_PORT`, `DB_USER`,
  `DB_PASSWORD`, `DB_NAME`. No other name (`MYSQL_*`,
  `DATABASE_URL`, …) is read anywhere.
- The pool is `mysql2/promise` `createPool({ ...config.db,
  waitForConnections: true, connectionLimit: 10, queueLimit: 0 })`
  in `server/src/lib/store.js`, and `scripts/migrate.js` uses the
  same `config.db` with `createConnection`. No socket path, no
  SSL option, no auth-plugin override — the standard mysql2
  defaults, which support both `caching_sha2_password` (MySQL 8)
  and `mysql_native_password`.
- **There is no dotenv.** `package.json` has no `dotenv`
  dependency and no code requires it. The app reads
  `process.env` only. A `.env` file on disk is **never read**.
- Config is read **once**, when the module is first required,
  and the pool is created once and cached. Changing a password
  or an env var has no effect on a running process until the
  Node app is **restarted**.
- Before this fix, `/health` kept only the error **code**
  (`ER_ACCESS_DENIED_ERROR`). The sanitised message — which
  names the user and host MySQL saw, and whether a password was
  sent — was discarded. That is why the failure looked
  un-diagnosable from the app side.

## The safe diagnostic (added)

`/health` and `/ready` now report, and `scripts/db-diagnose.js`
prints, only safe facts — never a password or a connection string:

```json
{
  "db_error": {
    "code": "ER_ACCESS_DENIED_ERROR",
    "errno": 1045,
    "sql_state": "28000",
    "message": "Access denied for user 'u123456789_paycrypto_user'@'localhost' (using password: YES)",
    "attempted_user": "u123456789_paycrypto_user",
    "attempted_host": "localhost",
    "using_password": "YES"
  },
  "db_config": {
    "host": "localhost", "port": 3306,
    "user": "u123456789_paycrypto_user", "database": "u123456789_paycrypto",
    "password": { "present": true, "length": 16, "has_leading_trailing_whitespace": false, "quoted": false },
    "env_present": { "DB_HOST": true, "DB_PORT": true, "DB_USER": true, "DB_PASSWORD": true, "DB_NAME": true }
  },
  "dotenv": { "dotenv_installed": false, "env_file_present": false, "env_file_read_by_app": false }
}
```

The password is reported only as present / length / whitespace /
quoted. The message is **reconstructed** from allow-listed
patterns, never the raw driver text, so no credential can leak
through it. The startup log prints the same sanitised object.

Run the diagnostic:

```bash
node scripts/db-diagnose.js
```

Note where you run it: hPanel Node env vars are injected only
into the app process. From an SSH shell they are absent, so the
script will show the app defaults unless you export the same
`DB_*` values first. The live `/health` endpoint is the
authoritative check, because it runs inside the app process.

## Ranked likely root causes on Hostinger

### 1. Credentials were set only in a `.env` file (most likely if you followed the old docs)

The old `docs/HOSTINGER.md` said "Copy `.env.example` to `.env`
and set DB_*". That instruction was wrong for this codebase:
without dotenv, `.env` is ignored and the app falls back to
`DB_USER=paycrypto_user`, `DB_PASSWORD=''` (empty),
`DB_NAME=paycrypto` — which MySQL rejects with 1045
"(using password: NO)".

**Fix:** set all five `DB_*` values in **hPanel > Node.js app >
Environment Variables**, then **Restart application**. The
`.env` file, if present, can stay or be removed; it changes
nothing. (Docs corrected in this commit.)

How to tell from `/health`: `db_config.env_present` will show
`DB_USER: false` / `DB_PASSWORD: false` (or the defaults
`paycrypto_user` / empty password), and `db_error.message`
will say `(using password: NO)` or name the default user.

### 2. Unprefixed database / username (most likely if you copied `.env.example`)

Hostinger prefixes every MySQL database and username with your
account id, e.g. `u123456789_paycrypto` and
`u123456789_paycrypto_user`, and the prefix cannot be removed
or changed (Hostinger support docs). `.env.example` used the
unprefixed names `paycrypto_user` / `paycrypto` as placeholders.
A user `paycrypto_user` simply does not exist on the server,
so MySQL answers 1045 however correct the password is.

**Fix:** copy the **full** names exactly as shown in
hPanel > Databases > List of Current MySQL Databases And Users
into the Node app env vars `DB_USER` and `DB_NAME`, then
restart. Also note: each Hostinger database has exactly **one**
user — the user must be the one created for that database.

How to tell from `/health`: `db_error.attempted_user` will be
the unprefixed name, or a name that does not match the hPanel
list.

### 3. Password changed in one place but not the other, or app not restarted

Changing the password in hPanel > Databases changes the MySQL
credential, but the Node app env var `DB_PASSWORD` still holds
the old value until you update it there too — and the running
process keeps the old config until you restart the app.

**Fix:** set the new password in the Node app env vars to the
exact value set in hPanel Databases, then **Restart
application**. Do not change the password and the env var in
separate sessions without the restart in between.

How to tell from `/health`: `attempted_user` is the correct
prefixed user, `using_password: YES`, but it still fails.
`db_config.password.length` tells you whether the app is even
sending a password of the length you expect (compare lengths
only — never paste the password anywhere).

### 4. Accidental whitespace or quotes in a value

A trailing space/newline from copy-paste, or wrapping the
value in `"..."` in the hPanel field, makes the password (or
username) a different string. Identifiers (`DB_HOST`,
`DB_USER`, `DB_NAME`) are now trimmed by the app; the password
is deliberately **not** trimmed, because a password could
legitimately contain spaces — instead the diagnostic flags
`password.has_leading_trailing_whitespace` and
`password.quoted`.

**Fix:** re-enter the value in hPanel without surrounding
quotes or trailing spaces, then restart.

### 5. User not granted from the app's host

MySQL grants are per `user@host`. Hostinger's MySQL users are
created for `localhost` on shared hosting, and `DB_HOST`
must be `localhost` (port 3306). If `DB_HOST` were set to a
remote hostname, an IP, or `127.0.0.1`, the grant may not
match — that also surfaces as 1045, with `attempted_host`
showing the host MySQL saw.

**Fix:** set `DB_HOST=localhost`, `DB_PORT=3306` in the Node
app env vars, then restart.

## What is NOT the cause (ruled out by the code)

- **dotenv overriding Hostinger vars:** there is no dotenv to
  override anything; the direction of the bug is the opposite
  (`.env` ignored).
- **Wrong env-var names in code:** the code reads exactly
  `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- **Stale pool after a password change in the same process:**
  possible only if the app was not restarted — see cause 3.
  The pool itself is created lazily on first query and uses
  the config snapshot from startup; it does not re-read env.
- **Auth plugin mismatch:** mysql2 supports the MySQL 8
  default plugin; a plugin problem would not present as a
  plain 1045 with a named user.
- **Schema / migrations / data:** 1045 happens before any
  table is touched. Nothing here changes the schema or data.

## Exact information needed from Hostinger Support (only if the above does not fix it)

Send them only the sanitised `/health` output (or the
`db-diagnose.js` output) — it contains no password. Ask:

1. "For database `<db_config.database>` and user
   `<db_config.user>`, is the user granted on that database,
   and from which host (`localhost` / `%` / other)?"
2. "Was the password for that user changed at <time>, and is
   the current password the one set in the Node app env vars
   (compare only by resetting it to a known value, never by
   sending the password in the ticket)?"
3. "Is there any IP / remote-host restriction on this MySQL
   user, or is it `localhost`-only?"
4. "What is the MySQL server version and the default
   authentication plugin for this user?"

Do **not** send the password, the `.env` file, or a full
connection string in a support ticket.

## After the fix

1. Deploy, restart the Node app, open `/health` — it should
   show `db: "ready"`, `db_error: null`.
2. Open `/ready` — it should be HTTP 200.
3. Run `node scripts/migrate.js` (same env) only if the
   migrations have not been imported yet; a 1045 there means
   the same credential problem, not a migration problem.
4. Gates remain off: `PAYMENTS_LIVE=false`,
   `AUTO_SWEEP=false`, `WITHDRAWAL_AUTO_BROADCAST=false`.
