const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const ENVIRONMENT = process.env.ENVIRONMENT || 'local';

function route(suffix = '') {
  if (!BASE_PATH) {
    return suffix || '/';
  }
  if (!suffix || suffix === '/') {
    return [BASE_PATH, `${BASE_PATH}/`];
  }
  return `${BASE_PATH}${suffix}`;
}

app.get(route('/'), (req, res) => {
  res.json({
    message: 'Project Simba demo API is live',
    team: 'Platform Engineering',
    environment: ENVIRONMENT,
  });
});

app.get(route('/health'), (req, res) => {
  res.status(200).json({ status: 'healthy', environment: ENVIRONMENT });
});

app.get(route('/version'), (req, res) => {
  res.json({
    version: process.env.APP_VERSION || 'dev',
    commit: process.env.GIT_SHA || 'unknown',
    environment: ENVIRONMENT,
  });
});

/* istanbul ignore next */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Simba demo API listening on port ${PORT} (${ENVIRONMENT}${BASE_PATH || ''})`);
  });
}

module.exports = app;
