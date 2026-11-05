'use strict';
// MySQL TIMESTAMP/DATETIME values: convert JS ISO strings
// ("2026-11-05T07:00:00.000Z") to "2026-11-05 07:00:00" (UTC) before
// inserting, so Hostinger MySQL/MariaDB parsing does not depend on
// accepting the ISO "T"/"Z" form. Non-ISO values pass through unchanged.
function toMysqlDatetime(value) {
  if (value == null) return value;
  const s = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) return `${m[1]} ${m[2]}`;
  return s;
}
module.exports = { toMysqlDatetime };
