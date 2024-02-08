const http = require('http');
const config = require('./config/default');
const backupService = require('./src/services/backupService');
const app = require('./src/lib/server');
const log = require('./src/lib/log');

async function init() {
  const server = http.createServer(app);

  log.info('Starting Flux Backup/Restore Middleware Service');
  await backupService.init();
  server.listen(config.serverPort, () => {
    log.info(`App listening on port ${config.serverPort}`);
  });
}
init();
