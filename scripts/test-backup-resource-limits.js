/* eslint-disable no-await-in-loop, no-restricted-syntax, no-promise-executor-return */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const config = require('../config/default');
const fluxOS = require('../src/services/fluxOsService');
const taskFileStorage = require('../src/services/utils/taskFileStorage');
const log = require('../src/lib/log');

async function main() {
  const saved = { storagePath: config.storagePath, storageMinimumFreeGb: config.storageMinimumFreeGb, backupDownloadTimeoutMs: config.backupDownloadTimeoutMs };
  const originalAuth = fluxOS.verifyTeamLogin;
  const originalWriter = fs.createWriteStream;
  const savedLog = { info: log.info, error: log.error };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbm-resource-test-'));
  config.storagePath = root;
  config.storageMinimumFreeGb = 0;
  fluxOS.verifyTeamLogin = async () => 'synthetic-team-auth';
  log.info = () => {};
  log.error = () => {};
  // eslint-disable-next-line global-require
  const fileService = require('../src/services/fileService');
  let written = 0;
  let disconnected = 0;
  fs.createWriteStream = (...args) => {
    const stream = originalWriter(...args);
    const { write } = stream;
    stream.write = function countWrite(chunk, ...rest) {
      written += chunk.length;
      return write.call(this, chunk, ...rest);
    };
    return stream;
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/headers') {
      res.writeHead(200, { 'content-length': 1000000 });
      res.end(Buffer.alloc(1024));
      return;
    }
    if (req.url === '/exact') { res.end('1234'); return; }
    if (req.url === '/short') { res.end('12'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('12');
    const timer = setInterval(() => res.write(req.url === '/slow' ? '1' : Buffer.alloc(1024)), 5);
    res.on('close', () => { clearInterval(timer); disconnected += 1; });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const task = (id, endpoint, filesize = 4) => ({
      taskId: id,
      filename: 'backup.tar.gz',
      filesize,
      backup_type: 'automatic',
      host: `http://127.0.0.1:${server.address().port}/${endpoint}`,
    });
    for (const endpoint of ['headers', 'chunked']) {
      const value = task(endpoint === 'headers' ? 100 : 101, endpoint);
      written = 0;
      await assert.rejects(fileService.downloadFileFromHost(value), (error) => error.code === 'BACKUP_DOWNLOAD_TOO_LARGE' && error.terminal);
      assert(written <= value.filesize, 'Never write any chunk that crosses the declared byte budget');
      assert(!fs.existsSync(taskFileStorage.getTaskDirectory(value)), 'Rejected downloads must leave no partial file');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(disconnected > 0, 'Oversized chunked sender must be disconnected');
    const exact = task(102, 'exact');
    await fileService.downloadFileFromHost(exact);
    assert.strictEqual(fs.readFileSync(taskFileStorage.getTaskFilePath(exact), 'utf8'), '1234');
    await assert.rejects(fileService.downloadFileFromHost(task(103, 'short')), /File size mismatch/);
    config.backupDownloadTimeoutMs = 60;
    const slow = task(104, 'slow', 100000);
    await assert.rejects(fileService.downloadFileFromHost(slow), (error) => error.code === 'BACKUP_DOWNLOAD_TIMEOUT');
    assert(!fs.existsSync(taskFileStorage.getTaskDirectory(slow)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(disconnected >= 2, 'Deadline must cancel the live socket, even when bytes keep arriving');
    await assert.rejects(fileService.downloadFileFromHost(task(105, 'exact', Number.MAX_SAFE_INTEGER + 1)), /Invalid expected backup size/);
    console.log('Backup streaming limits and deadline tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(config, saved);
    Object.assign(log, savedLog);
    fluxOS.verifyTeamLogin = originalAuth;
    fs.createWriteStream = originalWriter;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
