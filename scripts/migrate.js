'use strict';
// Runs db/migrations/*.sql in order against MySQL. Requires DB_* env vars.
//   node scripts/migrate.js
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../server/src/lib/config');

async function main() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    for (const f of files) {
      console.log('Applying', f);
      await conn.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    console.log('Migrations complete.');
  } finally { await conn.end(); }
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
