/* eslint-disable no-param-reassign */
const fs = require('fs');
const http = require('http');
const https = require('https');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const log = require('../lib/log');
const config = require('../../config/default');
const fluxOS = require('./fluxOsService');
const Vault = require('./Vault');
const taskFileStorage = require('./utils/taskFileStorage');

// Ensure the storage directory exists on module load
if (!fs.existsSync(config.storagePath)) {
  fs.mkdirSync(config.storagePath, { recursive: true });
  log.info(`Created storage directory: ${config.storagePath}`);
}

/**
 * checks if a file exists
 *
 * @param {Object} task - Backup task.
 */
function fileExists(task) {
  return fs.existsSync(taskFileStorage.getTaskFilePath(task));
}

/**
 * Deletes local artifacts belonging to one task.
 *
 * @param {Object} task - Backup task.
 * @throws Will throw an error if it fails.
 */
function deleteFile(task) {
  try {
    const result = taskFileStorage.removeTaskArtifacts(task);
    log.info(`Local backup artifacts deleted for task ${task.taskId}: ${task.filename}`);
    return result;
  } catch (error) {
    log.error(`Error deleting local artifacts for task ${task.taskId} (${task.filename}): ${error.message}`);
    throw error;
  }
}

/**
 * Probes the remote backup file size before downloading.
 *
 * @async
 * @param {Object} task
 * @returns {Promise<number|null>}
 */
async function getRemoteFileSize(task) {
  const url = new URL(`${task.host}`);
  const protocol = url.protocol.startsWith('https:') ? 'https' : 'http';
  const node = `${protocol}://${url.hostname}${url.port ? `:${url.port}` : ''}`;

  let zelidauth;
  try {
    zelidauth = await fluxOS.verifyLogin(
      await Vault.getKey('teamFluxID'),
      await Vault.getKey('teamPK'),
      node,
    );
  } catch (authError) {
    log.error('Failed to authenticate with node for file size probe:', authError);
    return null;
  }

  if (!zelidauth) {
    return null;
  }

  return new Promise((resolve) => {
    const requestFn = url.protocol.startsWith('https:') ? https.request : http.request;
    const request = requestFn({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'HEAD',
      headers: { zelidauth },
    }, (response) => {
      response.resume();
      const contentLength = response.headers['content-length'];
      if (response.statusCode >= 200 && response.statusCode < 300 && contentLength) {
        const parsedLength = Number(contentLength);
        resolve(Number.isFinite(parsedLength) ? parsedLength : null);
        return;
      }
      resolve(null);
    });

    request.on('error', () => resolve(null));
    request.setTimeout(15000, () => {
      request.destroy();
      resolve(null);
    });
    request.end();
  });
}

async function getDownloadResponse(url, headers, redirectsRemaining = 5) {
  const requestFn = url.protocol.startsWith('https:') ? https.get : http.get;
  const response = await new Promise((resolve, reject) => {
    const request = requestFn(url, { headers }, resolve);
    request.on('error', reject);
    request.setTimeout(5 * 60 * 1000, () => {
      request.destroy(new Error('Backup download timed out due to inactivity'));
    });
  });

  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.resume();
    if (redirectsRemaining === 0) {
      throw new Error('Backup download exceeded redirect limit');
    }
    const redirectUrl = new URL(response.headers.location, url);
    return getDownloadResponse(redirectUrl, headers, redirectsRemaining - 1);
  }

  return response;
}

/**
 * Downloads a file from a host for a given task.
 *
 * @async
 * @param {Object} task - The task object.
 * @returns {Promise<boolean>} - A promise that resolves to true when the file is successfully downloaded.
 * @throws Will throw an error if the download fails.
 */
async function downloadFileFromHost(task) {
  const { filename } = task;
  const url = new URL(`${task.host}`);

  // Construct node URL from hostname and port
  const protocol = url.protocol.startsWith('https:') ? 'https' : 'http';
  const node = `${protocol}://${url.hostname}${url.port ? `:${url.port}` : ''}`;

  // Get fresh zelidauth token first (outside of Promise)
  let zelidauth;
  try {
    zelidauth = await fluxOS.verifyLogin(
      await Vault.getKey('teamFluxID'),
      await Vault.getKey('teamPK'),
      node,
    );
  } catch (authError) {
    log.error('Failed to authenticate with node:', authError);
    throw authError;
  }

  if (!zelidauth) {
    throw new Error('Failed to authenticate with node');
  }
  const finalPath = taskFileStorage.getTaskFilePath(task);
  const partialPath = taskFileStorage.getTaskPartialFilePath(task);
  const expectedSize = Number(task.filesize);

  if (!Number.isFinite(expectedSize) || expectedSize < 0) {
    throw new Error(`Invalid expected backup size for task ${task.taskId}`);
  }

  taskFileStorage.ensureTaskDirectory(task);
  taskFileStorage.unlinkIfPresent(finalPath);
  taskFileStorage.unlinkIfPresent(partialPath);

  log.info(`Downloading ${filename} for task ${task.taskId} from ${url.href}`);
  try {
    const response = await getDownloadResponse(url, { zelidauth });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw new Error(`Backup download returned HTTP ${response.statusCode}`);
    }

    const contentLength = Number(response.headers['content-length']);
    let receivedBytes = 0;
    const progressStream = new Transform({
      transform(chunk, encoding, callback) {
        receivedBytes += chunk.length;
        const progressTotal = Number.isFinite(contentLength) && contentLength > 0
          ? contentLength : expectedSize;
        const progress = progressTotal > 0
          ? Number(((receivedBytes / progressTotal) * 100).toFixed(2)) : 0;
        task.status = { state: 'downloading', message: 'Fetching file from node', progress };
        callback(null, chunk);
      },
    });

    await pipeline(
      response,
      progressStream,
      fs.createWriteStream(partialPath, { flags: 'w' }),
    );

    const actualSize = fs.statSync(partialPath).size;
    if (actualSize !== expectedSize) {
      throw new Error(`File size mismatch ${expectedSize}<>${actualSize}`);
    }

    fs.renameSync(partialPath, finalPath);
    log.info(`${filename} downloaded successfully for task ${task.taskId}.`);
    task.status = { state: 'downloading', message: 'download finished', progress: 100 };
    task.downloaded = true;
    return true;
  } catch (error) {
    try {
      taskFileStorage.removeTaskArtifacts(task);
    } catch (cleanupError) {
      log.error(`Failed to clean local artifacts for task ${task.taskId}: ${cleanupError.message}`);
    }
    task.status = { state: 'failed', message: error.message, progress: 0 };
    task.downloaded = false;
    log.error(`Downloading ${filename} for task ${task.taskId} failed: ${error.message}`);
    throw error;
  }
}

module.exports = {
  fileExists,
  deleteFile,
  getRemoteFileSize,
  downloadFileFromHost,
};
