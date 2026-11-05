'use strict';
// Database error detection — used to return 503 (not 500, not a crash)
// when MySQL is unavailable, and to avoid leaking internal details.
// No credentials are ever included in these messages: mysql2 error
// messages are mapped to a generic string, never forwarded to clients.
const DB_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_CON_COUNT_ERROR',
  'ER_HOST_NOT_PRIVILEGED', 'ER_UNKNOWN_ERROR',
]);
function isDbError(err) {
  if (!err) return false;
  if (DB_CODES.has(err.code)) return true;
  if (typeof err.code === 'string' && err.code.startsWith('ER_')) return true;
  if (typeof err.message === 'string' && /connect|mysql|database/i.test(err.message) && /(ECONN|ETIMEDOUT|ENOTFOUND|ER_)/.test(err.message)) return true;
  return false;
}
const { sanitizeDbError } = require('./db-diagnostics');
module.exports = { isDbError, sanitizeDbError };
