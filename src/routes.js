const idService = require('./services/idService');
const fluxDrive = require('./services/fluxDrive');
const backupService = require('./services/backupService');
const log = require('./lib/log');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function registerRoutes(app) {
  app.get('/', (req, res) => {
    res.send({ status: 'OK' });
  });
  app.post('/verifylogin', asyncRoute(idService.verifyLogin));
  app.post('/registerbackupfile', asyncRoute(backupService.registerBackupTask));
  app.get('/getbackuplist', asyncRoute(backupService.getBackupList));
  app.get('/getTaskStatus', asyncRoute(backupService.getTaskStatus));
  app.post('/removeCheckpoint', asyncRoute(backupService.removeCheckpoint));
  app.get('/getfile', asyncRoute(fluxDrive.getFile));
  app.get('/dailybackupreport', asyncRoute(backupService.getDailyBackupReport));
  app.post('/dailybackupreport/send', asyncRoute(backupService.forceSendDailyBackupReport));
  app.post('/internal/syncthing-discovery', asyncRoute(backupService.forceSyncSyncthingApps));

  app.use((error, req, res, next) => {
    log.error(`[http] ${req.method} ${req.originalUrl} failed unexpectedly: ${error.stack || error.message || error}`);
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({
      status: 'error',
      data: { message: 'Internal server error' },
    });
  });
}

module.exports = registerRoutes;
module.exports.asyncRoute = asyncRoute;
