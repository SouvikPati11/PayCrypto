'use strict';
// Safe MySQL authentication diagnostic — read-only, no schema or data
// changes, no production data touched.
//
//   node scripts/db-diagnose.js
//
// It attempts ONE connection with the app's own config (DB_HOST,
// DB_PORT, DB_USER, DB_PASSWORD, DB_NAME from process.env) and prints
// only safe facts: the attempted identity (host/port/user/database),
// password facts (present / length / whitespace / quoted — never the
// value), whether a .env file exists and whether dotenv is installed,
// and on failure the sanitised MySQL error (code, errno, SQL state,
// "Access denied for user '<user>'@'<host>' (using password: YES|NO)".
// On success it also prints the MySQL server version and the
// CURRENT_USER() MySQL actually saw, which proves which user/host
// the server authenticated.
//
// Exit code 0 = connected, 1 = could not connect (the sanitised
// error above is the diagnosis), 2 = usage / unexpected error.
//
// IMPORTANT — where you run this matters:
//   * Inside the Hostinger Node app process, DB_* come from
//     hPanel > Node.js app > Environment Variables. The live
//     /health endpoint reports the same sanitised facts from the
//     actual app process and is the authoritative check.
//   * From an SSH / hPanel terminal shell, those hPanel env vars
//     are NOT automatically present, so this script will show the
//     app defaults (paycrypto_user / paycrypto / empty password)
//     unless you export the same DB_* values in that shell first.
//     That is expected — it does not mean the app is using them.
//   * This app has NO dotenv dependency and never reads a .env
//     file. A .env file on disk does not reach the app, however
//     correct its contents are.
const mysql = require('mysql2/promise');
const config = require('../server/src/lib/config');
const { dbConfigDiagnostics, dotenvStatus, sanitizeDbError } = require('../server/src/lib/db-diagnostics');

async function main() {
  const diag = dbConfigDiagnostics(config);
  const dotenv = dotenvStatus();
  console.log('PayCrypto MySQL diagnostic (safe: no password or connection string is printed)');
  console.log(JSON.stringify({ attempted: diag, dotenv }, null, 2));
  if (dotenv.env_file_present) {
    console.log('NOTE: a .env file exists on disk, but this app does NOT read .env files (no dotenv).');
    console.log('Set DB_* in hPanel > Node.js app > Environment Variables and restart the app.');
  }
  if (!diag.env_present.DB_PASSWORD) {
    console.log('NOTE: DB_PASSWORD is not set in this process environment — the app will attempt an empty password.');
  }
  let conn = null;
  try {
    conn = await mysql.createConnection({ ...config.db, connectTimeout: 5000 });
    const [ver] = await conn.query('SELECT VERSION() AS v');
    const [who] = await conn.query('SELECT CURRENT_USER() AS u');
    console.log(JSON.stringify({ ok: true, server_version: ver[0].v, current_user: who[0].u }, null, 2));
    console.log('Connection OK: authentication succeeded for the user above.');
    return 0;
  } catch (e) {
    const safe = sanitizeDbError(e);
    console.log(JSON.stringify({ ok: false, error: safe }, null, 2));
    if (safe && safe.code === 'ER_ACCESS_DENIED_ERROR') {
      console.log('Diagnosis: MySQL reached the server and rejected the login.');
      console.log(`  - MySQL saw user '${safe.attempted_user}' from host '${safe.attempted_host}', using password: ${safe.using_password}.`);
      console.log('  - This is NOT a wrong-database-name error (that would be ER_BAD_DB_ERROR / 1049).');
      console.log('  - Check, in hPanel > Databases > List of Current MySQL Databases And Users:');
      console.log('    (a) the full prefixed username (uXXXXXXXX_...) and database name match DB_USER / DB_NAME exactly,');
      console.log('    (b) the password in the Node app environment variables is the one set for that user,');
      console.log('    (c) the Node app was RESTARTED after the last password / env-var change (config is read once at startup).');
      console.log('  - See docs/DB_AUTH_DIAGNOSIS.md for the full checklist and the Hostinger Support questions.');
    }
    return 1;
  } finally {
    if (conn) { try { await conn.end(); } catch {} }
  }
}
if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error('Unexpected error:', e.code || e.message); process.exitCode = 2; });
}
module.exports = { main };
