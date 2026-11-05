'use strict';
// PayCrypto production entry point — Hostinger startup file.
// This file MUST start the server unconditionally when Hostinger loads
// it. It is deliberately NOT guarded by `require.main === module`:
// Hostinger's runtime logs warn that the entry file may be loaded
// without require.main === module being true, and in that case the old
// guard meant startServer() was never called at all — the exact
// "App did not call listen() within 3 seconds" failure.
// Order is preserved: production secrets are checked first, then the
// server starts immediately on process.env.PORT / 0.0.0.0, and only
// after listen() do database readiness and HD deriver checks run
// (see server/app.js). Tests must import server/app.js, NOT this
// file, so that importing the app does not start a production server.
const { assertProductionSecrets, startServer } = require('./app');
assertProductionSecrets();
startServer();
module.exports = require('./app');
