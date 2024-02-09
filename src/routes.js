const idService = require('./services/idService');
const fluxDrive = require('./services/fluxDrive');
const backupService = require('./services/backupService');

module.exports = (app) => {
  app.get('/', (req, res) => {
    res.send({ status: 'OK' });
  });
  app.post('/verifylogin', (req, res) => {
    idService.verifyLogin(req, res);
  });
  app.post('/registerbackupfile', (req, res) => {
    backupService.registerBackupTask(req, res);
  });
  app.get('/getbackuplist', (req, res) => {
    backupService.getBackupList(req, res);
  });
  app.get('/getStats', (req, res) => {
    backupService.getStats(req, res);
  });
  app.get('/getTaskStatus', (req, res) => {
    backupService.getTaskStatus(req, res);
  });
  app.get('/getfile', (req, res) => {
    fluxDrive.getFile(req, res);
  });
};
