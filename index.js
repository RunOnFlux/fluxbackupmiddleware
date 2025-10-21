const http = require('http');
const config = require('./config/default');
const backupService = require('./src/services/backupService');
const app = require('./src/lib/server');
const log = require('./src/lib/log');

// Global error handlers to prevent app crashes
process.on('uncaughtException', (error) => {
  log.error('UNCAUGHT EXCEPTION - Process will continue:', error);
  log.error('Stack trace:', error.stack);
  // In production, you might want to exit gracefully after logging
  // process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('UNHANDLED PROMISE REJECTION at:', promise);
  log.error('Rejection reason:', reason);
  // Optionally convert to exception
  // throw reason;
});

// Handle SIGTERM and SIGINT for graceful shutdown
process.on('SIGTERM', () => {
  log.info('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT signal received: closing HTTP server');
  process.exit(0);
});

async function init() {
  const server = http.createServer(app);

  log.info('Starting Flux Backup/Restore Middleware Service');
  await backupService.init();
  server.listen(config.serverPort, () => {
    log.info(`App listening on port ${config.serverPort}`);
  });
}
init();
