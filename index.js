const http = require('http');
const config = require('./config/default');
const backupService = require('./src/services/backupService');
const app = require('./src/lib/server');
const log = require('./src/lib/log');

let server = null;
let shuttingDown = false;

function getErrorDetails(error) {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch (serializationError) {
    return String(error);
  }
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(exitCode), 5000);
  const exitAfterLogsFlush = () => {
    Promise.resolve(typeof log.flush === 'function' ? log.flush() : null)
      .catch((error) => {
        process.stderr.write(`Failed to flush logs during shutdown: ${getErrorDetails(error)}\n`);
      })
      .finally(() => {
        clearTimeout(forceExit);
        process.exit(exitCode);
      });
  };
  if (server?.listening) {
    server.close(exitAfterLogsFlush);
  } else {
    exitAfterLogsFlush();
  }
}

function handleFatalError(kind, error) {
  const details = getErrorDetails(error);
  // stderr is the fallback when the file logger itself caused the failure.
  process.stderr.write(`${kind}: ${details}\n`);
  log.error(`${kind}:`, error);
  shutdown(1);
}

process.on('uncaughtException', (error) => {
  handleFatalError('UNCAUGHT EXCEPTION', error);
});

process.on('unhandledRejection', (reason) => {
  handleFatalError('UNHANDLED PROMISE REJECTION', reason);
});

// Handle SIGTERM and SIGINT for graceful shutdown
process.on('SIGTERM', () => {
  log.info('SIGTERM signal received: closing HTTP server');
  shutdown(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT signal received: closing HTTP server');
  shutdown(0);
});

async function init() {
  server = http.createServer(app);

  log.info('Starting Flux Backup/Restore Middleware Service');
  await backupService.init();
  server.listen(config.serverPort, () => {
    log.info(`App listening on port ${config.serverPort}`);
  });
}
init().catch((error) => {
  handleFatalError('STARTUP FAILURE', error);
});
