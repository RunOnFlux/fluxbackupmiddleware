/* eslint-disable no-await-in-loop, no-promise-executor-return */
const assert = require('assert');
const http = require('http');
const backup = require('../src/services/backupService');
const idService = require('../src/services/idService');

async function main() {
  const oldRegister = backup.registerBackupTask;
  const oldLogin = idService.verifyLogin;
  let registrations = 0;
  let logins = 0;
  backup.registerBackupTask = (req, res) => { registrations += 1; res.json({ status: 'success' }); };
  idService.verifyLogin = (req, res) => { logins += 1; res.json({ status: 'success' }); };
  // Capture the actual route wiring, without accessing any real user or node.
  // eslint-disable-next-line global-require
  const app = require('../src/lib/server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let forwarded = 0;
  const request = (endpoint, method = 'POST') => new Promise((resolve, reject) => {
    forwarded += 1;
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: endpoint,
      method,
      headers: { 'X-Forwarded-For': `198.51.${Math.floor(forwarded / 256)}.${forwarded % 256}` },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    for (let n = 0; n < 60; n += 1) assert.strictEqual((await request('/registerbackupfile')).status, 200);
    const limited = await request('/REGISTERBACKUPFILE');
    assert.strictEqual(limited.status, 429);
    assert(Number(limited.headers['retry-after']) > 0);
    assert.strictEqual(registrations, 60, 'Rate limiting runs before registration work and ignores forged forwarding headers');
    for (let n = 0; n < 30; n += 1) assert.strictEqual((await request('/verifylogin')).status, 200);
    assert.strictEqual((await request('/verifylogin')).status, 429);
    assert.strictEqual(logins, 30);
    let globalLimited = false;
    for (let n = 0; n < 610; n += 1) {
      if ((await request('/', 'GET')).status === 429) { globalLimited = true; break; }
    }
    assert(globalLimited, 'Global request budget must also apply to read endpoints');
    console.log('API rate limiting and forwarding-header bypass tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    backup.registerBackupTask = oldRegister;
    idService.verifyLogin = oldLogin;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
