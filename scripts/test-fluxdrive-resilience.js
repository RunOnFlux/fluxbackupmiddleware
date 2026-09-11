const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const config = require('../config/default');
const Vault = require('../src/services/Vault');
const log = require('../src/lib/log');
const taskFileStorage = require('../src/services/utils/taskFileStorage');
const fluxDrive = require('../src/services/fluxDrive');

const originalStoragePath = config.storagePath;
const originalUploadTimeout = config.fluxDriveUploadInactivityTimeoutMs;
const originalGetKey = Vault.getKey;
const originalLogError = log.error;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
  });
}

async function main() {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-upload-test-'));
  const server = http.createServer((request, response) => {
    if (request.url === '/api/v0/cat') {
      response.writeHead(200, { 'content-type': 'application/x-tar' });
      response.end('archive-data');
    }
    // Deliberately leave upload responses open to exercise the inactivity timeout.
  });

  try {
    await listen(server);
    const { port } = server.address();
    config.storagePath = storageRoot;
    config.fluxDriveUploadInactivityTimeoutMs = 50;
    Vault.getKey = async (key) => {
      if (key === 'fluxDriveServer') return `127.0.0.1:${port}`;
      return 'test-secret';
    };
    log.error = () => {};

    const task = {
      taskId: 9001,
      appname: 'test-app',
      filename: 'backup_test.tar.gz',
    };
    taskFileStorage.ensureTaskDirectory(task);
    fs.writeFileSync(taskFileStorage.getTaskFilePath(task), 'test-upload');

    await assert.rejects(fluxDrive.uploadFile(task), (error) => {
      assert.strictEqual(error.code, 'FLUXDRIVE_UPLOAD_TIMEOUT');
      assert.strictEqual(error.diagnostic.check, 'FluxDrive upload');
      assert.strictEqual(error.diagnostic.errorCode, 'FLUXDRIVE_UPLOAD_TIMEOUT');
      return true;
    });

    const chunks = [];
    const response = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    response.headersSent = false;
    response.statusCode = 200;
    response.responseHeaders = {};
    response.setHeader = (name, value) => {
      response.responseHeaders[name.toLowerCase()] = value;
    };
    response.set = response.setHeader;
    response.status = (statusCode) => {
      response.statusCode = statusCode;
      return response;
    };
    response.json = (body) => {
      chunks.push(Buffer.from(JSON.stringify(body)));
      response.end();
    };

    await fluxDrive.getFile(
      { params: {}, query: { filename: 'test-hash' } },
      response,
    );
    assert.strictEqual(Buffer.concat(chunks).toString(), 'archive-data');
    assert.strictEqual(response.responseHeaders['content-type'], 'application/x-tar');
  } finally {
    config.storagePath = originalStoragePath;
    config.fluxDriveUploadInactivityTimeoutMs = originalUploadTimeout;
    Vault.getKey = originalGetKey;
    log.error = originalLogError;
    if (server.listening) await close(server);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }

  console.log('FluxDrive resilience tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
