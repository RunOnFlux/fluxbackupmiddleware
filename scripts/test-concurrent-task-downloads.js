const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const config = require('../config/default');
const fluxOS = require('../src/services/fluxOsService');
const Vault = require('../src/services/Vault');
const log = require('../src/lib/log');
const taskFileStorage = require('../src/services/utils/taskFileStorage');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-download-test-'));
const originalStoragePath = config.storagePath;
const originalFluxDriveMaxFileSizeMb = config.fluxDriveMaxFileSizeMb;
const originalStorageMinimumFreeGb = config.storageMinimumFreeGb;
const originalVerifyTeamLogin = fluxOS.verifyTeamLogin;
const originalGetKey = Vault.getKey;
const originalLogInfo = log.info;
const originalLogError = log.error;

const firstContent = Buffer.from('first-task-content'.repeat(4096));
const secondContent = Buffer.from('second-task-content'.repeat(4096));

async function listen(server) {
  await new Promise((resolve, reject) => {
    const handleError = (error) => reject(error);
    server.once('error', handleError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', handleError);
      resolve();
    });
  });
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
  });
}

async function main() {
  config.storagePath = storageRoot;
  fluxOS.verifyTeamLogin = async () => 'test-auth';
  Vault.getKey = async () => 'test-secret';
  log.info = () => {};
  log.error = () => {};
  // Require after changing storagePath so module initialization uses the test directory.
  // eslint-disable-next-line global-require
  const fileService = require('../src/services/fileService');

  const server = http.createServer((request, response) => {
    if (request.url === '/missing') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    if (request.url === '/unexpected') {
      const responseBody = JSON.stringify({ status: 'error', message: 'backup file is not available' });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(responseBody);
      return;
    }
    if (request.url === '/remote-file-missing') {
      const responseBody = JSON.stringify({
        status: 'error',
        data: {
          code: 1,
          name: 'Error',
          message: "chmod: cannot access '/backup/local/backup_wp.tar.gz': No such file or directory",
        },
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(responseBody);
      return;
    }
    const content = request.url === '/first' ? firstContent : secondContent;
    response.writeHead(200, { 'content-length': content.length });
    const midpoint = Math.floor(content.length / 2);
    response.write(content.subarray(0, midpoint));
    setTimeout(() => response.end(content.subarray(midpoint)), 25);
  });

  try {
    await listen(server);
    const { port } = server.address();
    const firstTask = {
      taskId: 4524,
      filename: 'backup_wp.tar.gz',
      filesize: firstContent.length,
      host: `http://127.0.0.1:${port}/first`,
    };
    const secondTask = {
      taskId: 4527,
      filename: 'backup_wp.tar.gz',
      filesize: secondContent.length,
      host: `http://127.0.0.1:${port}/second`,
    };

    await Promise.all([
      fileService.downloadFileFromHost(firstTask),
      fileService.downloadFileFromHost(secondTask),
    ]);

    const firstPath = taskFileStorage.getTaskFilePath(firstTask);
    const secondPath = taskFileStorage.getTaskFilePath(secondTask);
    assert.deepStrictEqual(fs.readFileSync(firstPath), firstContent);
    assert.deepStrictEqual(fs.readFileSync(secondPath), secondContent);
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskPartialFilePath(firstTask)), false);
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskPartialFilePath(secondTask)), false);

    fileService.deleteFile(firstTask);
    assert.strictEqual(fs.existsSync(firstPath), false);
    assert.strictEqual(fs.existsSync(secondPath), true);

    const missingTask = {
      taskId: 4530,
      filename: 'backup_wp.tar.gz',
      filesize: firstContent.length,
      host: `http://127.0.0.1:${port}/missing`,
    };
    await assert.rejects(
      fileService.downloadFileFromHost(missingTask),
      /Backup download returned HTTP 404/,
    );
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskFilePath(missingTask)), false);
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskPartialFilePath(missingTask)), false);

    const mismatchedTask = {
      taskId: 4531,
      filename: 'backup_wp.tar.gz',
      filesize: firstContent.length + 1,
      host: `http://127.0.0.1:${port}/first`,
    };
    await assert.rejects(
      fileService.downloadFileFromHost(mismatchedTask),
      /File size mismatch/,
    );
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskFilePath(mismatchedTask)), false);
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskPartialFilePath(mismatchedTask)), false);

    const unexpectedResponseTask = {
      taskId: 4532,
      filename: 'backup_wp.tar.gz',
      filesize: firstContent.length,
      host: `http://127.0.0.1:${port}/unexpected`,
    };
    await assert.rejects(
      fileService.downloadFileFromHost(unexpectedResponseTask),
      (error) => {
        assert.strictEqual(error.code, 'FLUX_NODE_DOWNLOAD_ERROR');
        assert.match(error.message, /Flux node rejected backup download/);
        assert.strictEqual(error.diagnostic.check, 'Flux node backup download');
        assert.strictEqual(error.diagnostic.httpStatus, 200);
        assert(error.diagnostic.receivedSize > 0);
        assert(error.diagnostic.responseBody.includes('backup file is not available'));
        return true;
      },
    );

    const missingRemoteFileTask = {
      taskId: 4535,
      filename: 'backup_wp.tar.gz',
      filesize: firstContent.length,
      host: `http://127.0.0.1:${port}/remote-file-missing`,
    };
    await assert.rejects(
      fileService.downloadFileFromHost(missingRemoteFileTask),
      (error) => {
        assert.strictEqual(error.code, 'REMOTE_BACKUP_FILE_MISSING');
        assert.strictEqual(error.terminal, true);
        assert.strictEqual(error.httpStatus, 200);
        assert.strictEqual(error.diagnostic.httpStatus, 200);
        assert.match(error.message, /no longer exists on Flux node/);
        assert(error.diagnostic.responseBody.includes('No such file or directory'));
        return true;
      },
    );
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskFilePath(missingRemoteFileTask)), false);
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskPartialFilePath(missingRemoteFileTask)), false);

    const oversizedTask = {
      taskId: 4533,
      filename: 'backup_wp.tar.gz',
      filesize: firstContent.length,
      host: `http://127.0.0.1:${port}/first`,
    };
    config.fluxDriveMaxFileSizeMb = 0.001;
    await assert.rejects(
      fileService.downloadFileFromHost(oversizedTask),
      (error) => error.code === 'FLUXDRIVE_FILE_TOO_LARGE' && error.terminal === true,
    );
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskDirectory(oversizedTask)), false);
    config.fluxDriveMaxFileSizeMb = originalFluxDriveMaxFileSizeMb;

    const capacityTask = {
      taskId: 4534,
      filename: 'backup_wp.tar.gz',
      filesize: firstContent.length,
      host: `http://127.0.0.1:${port}/first`,
    };
    config.storageMinimumFreeGb = Number.MAX_SAFE_INTEGER;
    await assert.rejects(
      fileService.downloadFileFromHost(capacityTask),
      (error) => error.code === 'INSUFFICIENT_LOCAL_STORAGE'
        && error.deferWithoutFailure === true,
    );
    assert.strictEqual(fs.existsSync(taskFileStorage.getTaskDirectory(capacityTask)), false);

    console.log('Concurrent task download tests passed');
  } finally {
    if (server.listening) await close(server);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    config.storagePath = originalStoragePath;
    config.fluxDriveMaxFileSizeMb = originalFluxDriveMaxFileSizeMb;
    config.storageMinimumFreeGb = originalStorageMinimumFreeGb;
    fluxOS.verifyTeamLogin = originalVerifyTeamLogin;
    Vault.getKey = originalGetKey;
    log.info = originalLogInfo;
    log.error = originalLogError;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
