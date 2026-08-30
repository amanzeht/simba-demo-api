const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;

// Simple root endpoint - what people will see when they hit the demo URL
app.get('/', (req, res) => {
  res.json({
    message: 'Project Simba demo API is live',
    team: 'Platform Engineering',
  });
});

// Health check - used by the ECS load balancer / target group
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Version endpoint - proves which commit is actually running in the cluster,
// which is the whole point of the demo (commit -> pipeline -> deployed)
app.get('/version', (req, res) => {
  res.json({
    version: process.env.APP_VERSION || 'dev',
    commit: process.env.GIT_SHA || 'unknown',
  });
});

/* istanbul ignore next */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Simba demo API listening on port ${PORT}`);
  });
}

module.exports = app;
