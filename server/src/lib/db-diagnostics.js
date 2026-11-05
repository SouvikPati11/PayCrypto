'use strict';
// Safe MySQL diagnostics — for ER_ACCESS_DENIED_ERROR (1045) and other
// DB failures on Hostinger. This module NEVER returns, logs or exposes
// a password, a connection string, or any raw error text that could
// contain one. It reports only:
//   - the MySQL error code / errno / SQL state
//   - a sanitised message reconstructed from the error (never the raw
//     message — mysql2 messages are safe in practice, but a future
//     driver or a wrapped error could echo a credential, so only
//     allow-listed patterns are ever reproduced)
//   - the user@host MySQL reports it saw (from the sanitised message)
//   - the identity the app attempted (host, port, user, database —
//     these are identifiers, not secrets)
//   - password facts only as booleans / a length: present, length,
//     has leading/trailing whitespace, wrapped in quotes
// Nothing here can distinguish a right password from a wrong one
// except by attempting the connection; the password value is never
// compared, printed, hashed or stored by this module.
const fs = require('node:fs');
const path = require('node:path');

function _passwordFacts(password) {
  const pw = typeof password === 'string' ? password : '';
  return {
    present: pw.length > 0,
    length: pw.length,
    has_leading_trailing_whitespace: pw !== pw.trim(),
    quoted: (pw.startsWith('"') && pw.endsWith('"') && pw.length >= 2)
      || (pw.startsWith("'") && pw.endsWith("'") && pw.length >= 2),
  };
}

// Identity the app will attempt, plus password facts. Safe for
// /health, logs and support tickets: no password value, no DSN.
function dbConfigDiagnostics(config) {
  const db = (config && config.db) || {};
  return {
    host: db.host || null,
    port: db.port || null,
    user: db.user || null,
    database: db.database || null,
    password: _passwordFacts(db.password),
    env_present: {
      DB_HOST: process.env.DB_HOST !== undefined && process.env.DB_HOST !== '',
      DB_PORT: process.env.DB_PORT !== undefined && process.env.DB_PORT !== '',
      DB_USER: process.env.DB_USER !== undefined && process.env.DB_USER !== '',
      DB_PASSWORD: process.env.DB_PASSWORD !== undefined && process.env.DB_PASSWORD !== '',
      DB_NAME: process.env.DB_NAME !== undefined && process.env.DB_NAME !== '',
    },
  };
}

// Whether a .env file exists on disk and whether dotenv is even
// installed. PayCrypto has NO dotenv dependency and never reads a
// .env file — the app reads process.env only. A .env file present
// on Hostinger therefore does NOT reach the app; credentials must
// be set in hPanel > Node.js app > Environment Variables.
function dotenvStatus() {
  let dotenvInstalled = false;
  try { require.resolve('dotenv'); dotenvInstalled = true; } catch { dotenvInstalled = false; }
  const envFile = path.join(__dirname, '..', '..', '..', '.env');
  return {
    dotenv_installed: dotenvInstalled,
    env_file_present: fs.existsSync(envFile),
    env_file_read_by_app: false,
  };
}

// Sanitise a mysql2 error. Returns null for a non-error.
// Only these canonical messages are ever reproduced:
//   - Access denied for user '<user>'@'<host>' (using password: YES|NO)
//   - Unknown database '<name>'
//   - Host '<host>' is not allowed to connect to this MySQL server
//   - connect <CODE> <host>:<port>  (ECONNREFUSED / ETIMEDOUT / ENOTFOUND)
// Anything else becomes a generic message with the code only, so no
// raw driver text — and therefore no credential — can leak.
function sanitizeDbError(err) {
  if (!err) return null;
  const code = err.code || 'DB_ERROR';
  const errno = typeof err.errno === 'number' ? err.errno : null;
  const sqlState = err.sqlState || null;
  const msg = typeof err.message === 'string' ? err.message : '';
  let message = `Database error (${code})`;
  let attemptedUser = null;
  let attemptedHost = null;
  let usingPassword = null;
  const denied = msg.match(/Access denied for user '([^']*)'@'([^']*)' \(using password: (YES|NO)\)/);
  if (denied) {
    attemptedUser = denied[1];
    attemptedHost = denied[2];
    usingPassword = denied[3];
    message = `Access denied for user '${attemptedUser}'@'${attemptedHost}' (using password: ${usingPassword})`;
  } else {
    const unknownDb = msg.match(/Unknown database '([^']*)'/);
    if (unknownDb) {
      message = `Unknown database '${unknownDb[1]}'`;
    } else {
      const hostDenied = msg.match(/Host '([^']*)' is not allowed to connect/);
      if (hostDenied) {
        attemptedHost = hostDenied[1];
        message = `Host '${attemptedHost}' is not allowed to connect to this MySQL server`;
      } else {
        const conn = msg.match(/^connect (ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE) (\S+)/);
        if (conn) message = `connect ${conn[1]} ${conn[2]}`;
      }
    }
  }
  return {
    code,
    errno,
    sql_state: sqlState,
    message,
    attempted_user: attemptedUser,
    attempted_host: attemptedHost,
    using_password: usingPassword,
  };
}

module.exports = { dbConfigDiagnostics, dotenvStatus, sanitizeDbError };
