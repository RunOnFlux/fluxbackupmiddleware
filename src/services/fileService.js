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

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * 1024 * 1024;
const downloadReservations = new Map();

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

function getFluxDriveMaxFileSizeBytes() {
  return Number(config.fluxDriveMaxFileSizeMb) * MEBIBYTE;
}

function createFileSizeLimitError(task) {
  const error = new Error(
    `Backup file size ${task.filesize} bytes exceeds FluxDrive upload limit of ${config.fluxDriveMaxFileSizeMb} MiB`,
  );
  error.code = 'FLUXDRIVE_FILE_TOO_LARGE';
  error.terminal = true;
  error.diagnostic = {
    check: 'FluxDrive upload size limit',
    outcome: 'failed',
    endpoint: task.host || null,
    fileSize: Number(task.filesize) || 0,
    detail: error.message,
  };
  return error;
}

function validateFluxDriveFileSize(task) {
  const expectedSize = Number(task.filesize);
  const maxBytes = getFluxDriveMaxFileSizeBytes();
  if (!Number.isFinite(expectedSize) || expectedSize < 0) {
    throw new Error(`Invalid expected backup size for task ${task.taskId || 'new'}`);
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('FluxDrive maximum file size is not configured correctly');
  }
  if (expectedSize > maxBytes) throw createFileSizeLimitError(task);
  return expectedSize;
}

function getAvailableStorageBytes() {
  const stats = fs.statfsSync(config.storagePath);
  return Number(stats.bavail) * Number(stats.bsize);
}

function getReservedDownloadBytes() {
  let reservedBytes = 0;
  downloadReservations.forEach((reservation) => {
    reservedBytes += Math.max(0, reservation.expectedSize - reservation.receivedBytes);
  });
  return reservedBytes;
}

function reserveDownloadCapacity(task, expectedSize) {
  const taskId = Number(task.taskId);
  const availableBytes = getAvailableStorageBytes();
  const reservedBytes = getReservedDownloadBytes();
  const minimumFreeBytes = Number(config.storageMinimumFreeGb) * GIBIBYTE;
  const requiredBytes = expectedSize + reservedBytes + minimumFreeBytes;

  if (availableBytes < requiredBytes) {
    const error = new Error(
      `Insufficient local storage for backup download: available=${availableBytes} bytes, expected=${expectedSize} bytes, reserved=${reservedBytes} bytes, safetyReserve=${minimumFreeBytes} bytes`,
    );
    error.code = 'INSUFFICIENT_LOCAL_STORAGE';
    error.deferWithoutFailure = true;
    error.diagnostic = {
      check: 'Middleware download storage capacity',
      outcome: 'failed',
      endpoint: task.host || null,
      fileSize: expectedSize,
      detail: error.message,
    };
    throw error;
  }

  downloadReservations.set(taskId, { expectedSize, receivedBytes: 0 });
  log.info(`Reserved ${expectedSize} bytes for task ${taskId}; available=${availableBytes}, otherReserved=${reservedBytes}, safetyReserve=${minimumFreeBytes}`);
}

function updateDownloadReservation(taskId, receivedBytes) {
  const reservation = downloadReservations.get(Number(taskId));
  if (reservation) reservation.receivedBytes = receivedBytes;
}

function releaseDownloadCapacity(taskId) {
  downloadReservations.delete(Number(taskId));
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

async function getResponseSummary(response, maxLength = 500) {
  let summary = '';
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of response) {
    if (summary.length < maxLength) {
      summary += chunk.toString().slice(0, maxLength - summary.length);
    }
  }
  return summary.replace(/[\r\n]+/g, ' ');
}

function addDownloadDiagnostic(error, task, url, node, responseBody = null) {
  if (!error.diagnostic) {
    error.diagnostic = {
      check: 'Flux node backup download',
      outcome: 'failed',
      endpoint: url.href,
      node,
      httpStatus: error.httpStatus || null,
      errorCode: error.code || null,
      fileSize: Number(task.filesize) || 0,
      receivedSize: Number.isFinite(error.receivedSize) ? error.receivedSize : null,
      responseBody: responseBody || error.responseBody || null,
      detail: error.message,
    };
  }
  return error;
}

function getUnexpectedFilePreview(filePath, actualSize, maxLength = 500) {
  if (actualSize <= 0 || actualSize > 4096 || !fs.existsSync(filePath)) return null;
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(actualSize, maxLength));
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const preview = buffer.subarray(0, bytesRead).toString('utf8').replace(/[\r\n]+/g, ' ');
    const printableCharacters = preview.replace(/[^\x20-\x7E]/g, '').length;
    return printableCharacters / Math.max(preview.length, 1) >= 0.8 ? preview : null;
  } finally {
    fs.closeSync(descriptor);
  }
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
  const protocol = url.protocol.startsWith('https:') ? 'https' : 'http';
  const node = `${protocol}://${url.hostname}${url.port ? `:${url.port}` : ''}`;

  const expectedSize = validateFluxDriveFileSize(task);
  taskFileStorage.ensureTaskDirectory(task);
  taskFileStorage.unlinkIfPresent(taskFileStorage.getTaskFilePath(task));
  taskFileStorage.unlinkIfPresent(taskFileStorage.getTaskPartialFilePath(task));

  try {
    reserveDownloadCapacity(task, expectedSize);
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
      throw addDownloadDiagnostic(authError, task, url, node);
    }

    if (!zelidauth) {
      throw addDownloadDiagnostic(
        new Error('Failed to authenticate with node before backup download'),
        task,
        url,
        node,
      );
    }
    const finalPath = taskFileStorage.getTaskFilePath(task);
    const partialPath = taskFileStorage.getTaskPartialFilePath(task);

    log.info(`Downloading ${filename} for task ${task.taskId} from ${url.href}`);
    const response = await getDownloadResponse(url, { zelidauth });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const responseBody = await getResponseSummary(response);
      const httpError = new Error(`Backup download returned HTTP ${response.statusCode}`);
      httpError.httpStatus = response.statusCode;
      throw addDownloadDiagnostic(httpError, task, url, node, responseBody);
    }

    const contentLength = Number(response.headers['content-length']);
    let receivedBytes = 0;
    const progressStream = new Transform({
      transform(chunk, encoding, callback) {
        receivedBytes += chunk.length;
        updateDownloadReservation(task.taskId, receivedBytes);
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
      const sizeError = new Error(`File size mismatch ${expectedSize}<>${actualSize}`);
      sizeError.receivedSize = actualSize;
      sizeError.responseBody = getUnexpectedFilePreview(partialPath, actualSize);
      throw sizeError;
    }

    fs.renameSync(partialPath, finalPath);
    log.info(`${filename} downloaded successfully for task ${task.taskId}.`);
    task.status = { state: 'downloading', message: 'download finished', progress: 100 };
    task.downloaded = true;
    return true;
  } catch (error) {
    addDownloadDiagnostic(error, task, url, node);
    try {
      taskFileStorage.removeTaskArtifacts(task);
    } catch (cleanupError) {
      log.error(`Failed to clean local artifacts for task ${task.taskId}: ${cleanupError.message}`);
    }
    task.status = { state: 'failed', message: error.message, progress: 0 };
    task.downloaded = false;
    log.error(`Downloading ${filename} for task ${task.taskId} failed: ${error.message}`);
    throw error;
  } finally {
    releaseDownloadCapacity(task.taskId);
  }
}

module.exports = {
  fileExists,
  deleteFile,
  getRemoteFileSize,
  getFluxDriveMaxFileSizeBytes,
  validateFluxDriveFileSize,
  downloadFileFromHost,
};
