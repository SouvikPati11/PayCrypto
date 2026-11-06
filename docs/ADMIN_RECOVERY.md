# Super Admin Login — Root Cause, Fix, and Password Recovery

## Root cause (proven by reproduction, not guessed)

The login code itself is **correct**. Reproduced against a real
MySQL/MariaDB database with the exact production flow
(`scripts/seed-admin.js` → `POST /api/auth/login`):

- Seeding with a known password, then logging in with it, works
  (HTTP 200, `role: super_admin`), and the admin API answers with
  the session cookie. Wrong password → HTTP 401 `Invalid credentials`.
- `hashPassword` / `verifyPassword` are plain `bcryptjs` hash (cost
  12) / compare with no trimming, no double-hashing, and the hash
  is 60 chars in a `VARCHAR(255)` column. A direct bcrypt compare
  against the stored hash returns true for the seeded password and
  false for any other string.
- The frontend sends the password exactly as typed (no trim, no
  encoding change) to the relative path `/api/auth/login`, so the
  frontend cannot be talking to a different backend, and CSRF does
  not block login (no session exists yet).
- Email case and trailing spaces do **not** break login on MySQL:
  the default collation is case-insensitive and ignores trailing
  spaces, so `SOUVIKPATI22@GMAIL.COM` and `souvikpati22@gmail.com `
  both log in.

So when the stored hash does not match the password the operator
believes they set — and a direct bcrypt comparison also says
`PASSWORD_MISMATCH` — the password **string that was hashed at
seed time differs from the string being entered at login time**.
The code cannot tell you which string was typed where; no record
of it exists. Two mechanisms were reproduced that produce exactly
this symptom (seed prints success, login and direct bcrypt both fail):

1. **Shell `$` expansion of an unquoted `ADMIN_PASSWORD`.**
   Seeding with the unquoted value `LongPassword-$word42` stores
   the hash of `LongPassword-` (`$word42` expands to empty), while
   the operator believes the password is `LongPassword-$word42`.
   The seed still prints "Super admin created".
2. **Trailing whitespace in the seed-time password.** Seeding with
   `'Space-Pass-42 '` (trailing space) stores that exact string;
   logging in with `Space-Pass-42` fails. Passwords are never
   trimmed, by design.
3. **A leading space / uppercase `ADMIN_EMAIL` at seed time.**
   The old seed stored the email verbatim (`[  TEST6@Example.COM  ]`),
   and login with the clean address then returns 401 even though
   the account visibly exists with status `active`.

Other causes ruled out by the audit: wrong API endpoint (relative
paths only, no hardcoded production URL), wrong backend (same
origin), wrong database (the app's `/health` `db_config` names the
database it actually uses — compare it with the database you
inspected in phpMyAdmin), role validation (login does not reject
by role; it returns the role), JWT/session errors (login fails
before any token is involved), and missing admin routes (the
`/admin` page, `/api/admin/*` routes, and the admin dashboard all
exist and answer correctly once logged in).

## Fixes in this change

- **Email normalisation** (`normalizeEmail`: trim + lowercase) at
  every boundary — seed, register, login, recovery — so the email
  class of failure cannot recur. Passwords are still never trimmed.
- **`scripts/seed-admin.js`**: refuses `MEMORY_DB=true` (which
  would create a phantom in-memory admin while reporting success),
  and default settings are now only written for keys not already
  set, so a `wallet_xpub` / treasury address set earlier is never
  wiped by a re-run. Re-running still never resets a password.
- **Secure super_admin recovery** (`POST /api/auth/admin-recover`
  + page `/admin-recover`, linked from the login page): gated by a
  recovery code the owner sets in hPanel, rate-limited, generic
  errors, super_admin only, all sessions revoked, audit-logged,
  and it does not log the user in — the new password must then
  work at `/login`.
- **Admin dashboard UX**: unauthenticated / unauthorised loads now
  redirect to `/login` instead of showing an empty dashboard, and
  the admin and merchant dashboards have a working **Logout**
  button (the logout API existed but had no UI).

## Recovery procedure (no SSH / terminal needed)

You set the password privately; nobody else needs to know it.

### Step 1 — Set the recovery code in hPanel (web UI only)

1. hPanel → your website → **Node.js application** →
   **Environment Variables**.
2. Add: `ADMIN_RECOVERY_CODE` = a long random string you invent,
   **at least 20 characters** (for example 32 random
   letters/numbers — use a password generator, not a word).
   Do not use your admin password, and do not share this code.
3. Save, then click **Restart application** (or redeploy, if you
   deploy from Git — the new code is in the repository, so a
   redeploy also picks it up). The code is active only after the
   restart/redeploy.

### Step 2 — Reset the password in the browser

1. Open `https://<your-domain>/admin-recover` (or click
   "Recover the super_admin password" on the login page).
2. Enter: super admin email `souvikpati22@gmail.com`, the
   recovery code from Step 1, and a **new** password
   (at least 10 characters, different from the current one).
   Type it carefully — the password is stored exactly as typed,
   including any spaces, so do not add a trailing space.
3. Submit. On success you see: "Admin password reset. Log in at
   /login with the new password…". All previous sessions for
   that admin are revoked immediately.

### Step 3 — Log in and clean up

1. Open `https://<your-domain>/login` and log in with
   `souvikpati22@gmail.com` and the new password. You should
   land on `/admin`.
2. **Remove or rotate `ADMIN_RECOVERY_CODE`** in hPanel →
   Node.js app → Environment Variables, then restart the app.
   The code is a break-glass credential: it must not stay set
   indefinitely. If you need it again later, set a fresh one.
3. Enable two-factor authentication for the super_admin account
   from the admin area.

### If recovery says "Admin recovery is not configured"

The app was not restarted/redeployed after you set the code, or
the code is shorter than 20 characters. Check the hPanel env
vars, fix the length, and restart the app.

### If recovery says "Invalid recovery details"

Either the code, the email, or the role is wrong — the message
deliberately does not say which. Check the code character by
character (it is case-sensitive), the email spelling, and that
the account in the database really has role `super_admin`.
After 10 failed attempts in 15 minutes the endpoint rate-limits
further attempts; wait 15 minutes and try again.

## What this does not do

- It does not create a duplicate admin account.
- It does not touch merchants, invoices, transactions, ledger
  entries, wallet settings, or the blockchain configuration.
- It does not enable live payments, mainnet, automatic sweeping,
  or automatic withdrawals — all gates stay off.
- It does not weaken authentication: the recovery code is a
  separate, strong, owner-held secret, and the endpoint refuses
  to run without one.
