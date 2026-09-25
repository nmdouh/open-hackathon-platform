'use strict';

const path = require('node:path');
const express = require('express');
const { loadUser } = require('./auth/sessions');
const { securityHeaders, csrfGuard } = require('./lib/security');
const { HttpError, fromPg } = require('./lib/errors');
const { llmEnabled } = require('./lib/llm');

const WEB_ROOT = path.join(__dirname, '..', 'web');

function createApp({ pool, config, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);
  app.use(express.json({ limit: '200kb' }));
  app.use(csrfGuard);
  app.use(loadUser(pool));

  const ctx = { pool, config, logger };
  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });
  app.get('/api/config', (_req, res) => {
    res.json({ appName: config.appName, allowSignup: config.allowSignup, aiEnabled: llmEnabled(config) });
  });
  app.use('/api/auth', require('./modules/auth/routes')(ctx));
  app.use('/api', require('./modules/hackathons/routes')(ctx));
  app.use('/api/admin', require('./modules/admin/routes')(ctx));
  app.use('/api', require('./modules/governance/routes')(ctx));
  app.use('/api', require('./modules/mentoring/routes')(ctx));
  app.use('/api', require('./modules/toolbox/routes')(ctx));
  app.use('/api', require('./modules/participation/routes')(ctx));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NO_SUCH_ENDPOINT', 'Unknown API endpoint')));

  app.use(express.static(WEB_ROOT, { index: 'index.html', maxAge: config.production ? '1h' : 0 }));
  // Single-page app: unknown non-API paths render the shell.
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_ROOT, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let e = fromPg(err);
    if (e && e.type === 'entity.parse.failed') e = new HttpError(400, 'BAD_JSON', 'Malformed JSON body');
    if (e && e.type === 'entity.too.large') e = new HttpError(413, 'BODY_TOO_LARGE', 'Request body too large');
    if (!(e instanceof HttpError)) {
      logger.error(`[${req.method} ${req.originalUrl}]`, err);
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
    }
    res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
  });

  return app;
}

module.exports = { createApp };
