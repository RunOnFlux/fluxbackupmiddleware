const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const idService = require('./services/idService');
const fluxDrive = require('./services/fluxDrive');
const backupService = require('./services/backupService');
const log = require('./lib/log');
const adminAuth = require('./services/adminAuth');
const adminData = require('./services/adminData');

function adminPage(filename) {
  return (req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = fs.readFileSync(path.join(__dirname, '../ui', filename), 'utf8').replace(/__CSP_NONCE__/g, nonce);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    }).type('html').send(html);
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function registerRoutes(app) {
  app.get('/admin/login.html', adminPage('login.html'));
  app.get(['/admin', '/admin/'], adminAuth.requireAdminPage, adminPage('admin.html'));
  app.post('/admin/api/challenge', adminAuth.loginLimiter, adminAuth.requireOrigin, adminAuth.issueChallenge);
  app.post('/admin/api/login', adminAuth.loginLimiter, adminAuth.requireOrigin, adminAuth.login);
  app.post('/admin/api/wallet-callback', adminAuth.loginLimiter, adminAuth.walletCallback);
  app.post('/admin/api/wallet-status', adminAuth.walletStatusLimiter, adminAuth.requireOrigin, adminAuth.walletStatus);
  app.post('/admin/api/logout', adminAuth.requireAdmin, adminAuth.requireOrigin, adminAuth.logout);
  app.get('/admin/api/session', adminAuth.requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json({ address: req.adminAddress }));
  app.get('/admin/api/dashboard', adminAuth.requireAdmin, asyncRoute(adminData.dashboard));
  app.get('/admin/api/apps', adminAuth.requireAdmin, asyncRoute(adminData.apps));
  app.get('/admin/api/backups', adminAuth.requireAdmin, asyncRoute(adminData.backups));
  app.get('/admin/api/logs', adminAuth.requireAdmin, asyncRoute(adminData.logs));
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
