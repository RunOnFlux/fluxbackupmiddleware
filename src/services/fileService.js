/* eslint-disable no-param-reassign */
const fs = require('fs');
const http = require('http');
const https = require('https');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const log = require('../lib/log');
const config = require('../../config/default');
const fluxOS = require('./fluxOsService');
const idService = require('./idService');
const nodeAuthentication = require('./utils/nodeAuthentication');
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
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
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

function getTaskAuthHeader(task) {
  if (typeof task.extra !== 'string' || !task.extra) return null;
  try {
    const extra = JSON.parse(task.extra);
    if (extra?.failureDiagnostic) return typeof extra.auth === 'string' ? extra.auth : null;
  } catch (error) {
    // URL-encoded authentication headers are also supported.
  }
  return task.extra;
}

async function getTaskRequestAuthentication(task) {
  const url = nodeAuthentication.authenticatedNodeUrl(task.host);
  const suppliedAuth = getTaskAuthHeader(task);
  if (suppliedAuth) {
    const owner = await idService.verifyUserSession({ zelidauth: suppliedAuth });
    if (owner && owner === task.owner) {
      return { url, zelidauth: suppliedAuth };
    }
  }
  if (!String(task.backup_type || '').startsWith('automatic')) {
    throw nodeAuthentication.securityError('Manual backup authentication expired or is missing; register again with a valid owner session', 'BACKUP_OWNER_AUTH_REQUIRED');
  }
  const zelidauth = await fluxOS.verifyTeamLogin(url.origin);
  if (!zelidauth) throw new Error('Failed to authenticate with trusted backup node');
  return { url, zelidauth };
}

/**
 * Probes the remote backup file size before downloading.
 *
 * @async
 * @param {Object} task
 * @returns {Promise<number|null>}
 */
async function getRemoteFileSize(task) {
  let authentication;
  try {
    authentication = await getTaskRequestAuthentication(task);
  } catch (error) {
    return null;
  }
  const { url, zelidauth } = authentication;

  return new Promise((resolve) => {
    const requestFn = url.protocol.startsWith('https:') ? https.request : http.request;
    const request = requestFn({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'HEAD',
      rejectUnauthorized: true,
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

async function getDownloadResponse(url, headers, signal, redirectsRemaining = 5) {
  const requestFn = url.protocol.startsWith('https:') ? https.get : http.get;
  const response = await new Promise((resolve, reject) => {
    const request = requestFn(url, { headers, rejectUnauthorized: true, signal }, resolve);
    request.on('error', reject);
    request.setTimeout(5 * 60 * 1000, () => {
      request.destroy(new Error('Backup download timed out due to inactivity'));
    });
  });

  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.destroy();
    if (redirectsRemaining === 0) {
      throw new Error('Backup download exceeded redirect limit');
    }
    const redirectUrl = new URL(response.headers.location, url);
    nodeAuthentication.parseHttpUrl(redirectUrl.href);
    if (redirectUrl.origin !== url.origin) {
      throw nodeAuthentication.securityError('Authenticated backup downloads cannot redirect to another origin', 'BACKUP_REDIRECT_BLOCKED');
    }
    return getDownloadResponse(redirectUrl, headers, signal, redirectsRemaining - 1);
  }

  return response;
}

async function getResponseSummary(response, maxLength = 500) {
  let summary = '';
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of response) {
    summary += chunk.toString().slice(0, maxLength - summary.length);
    if (summary.length >= maxLength) break;
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

function getFluxNodeResponseError(responseBody, httpStatus) {
  if (!responseBody) return null;
  let payload;
  try {
    payload = JSON.parse(responseBody);
  } catch (error) {
    return null;
  }
  if (!payload || String(payload.status).toLowerCase() !== 'error') return null;

  const nodeMessage = payload.data?.message || payload.message || 'Unknown Flux node error';
  const remoteFileMissing = /no such file or directory/i.test(nodeMessage);
  const error = new Error(remoteFileMissing
    ? 'Remote backup file no longer exists on Flux node'
    : `Flux node rejected backup download: ${nodeMessage}`);
  error.code = remoteFileMissing
    ? 'REMOTE_BACKUP_FILE_MISSING'
    : 'FLUX_NODE_DOWNLOAD_ERROR';
  error.httpStatus = httpStatus;
  error.responseBody = responseBody;
  if (remoteFileMissing) error.terminal = true;
  return error;
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
  let url = nodeAuthentication.authenticatedNodeUrl(task.host);
  let node = url.origin;

  const expectedSize = validateFluxDriveFileSize(task);
  taskFileStorage.ensureTaskDirectory(task);
  taskFileStorage.unlinkIfPresent(taskFileStorage.getTaskFilePath(task));
  taskFileStorage.unlinkIfPresent(taskFileStorage.getTaskPartialFilePath(task));

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.backupDownloadTimeoutMs);
  deadline.unref();
  try {
    reserveDownloadCapacity(task, expectedSize);
    let zelidauth;
    try {
      ({ url, zelidauth } = await getTaskRequestAuthentication(task));
      node = url.origin;
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
    const response = await getDownloadResponse(url, { zelidauth }, controller.signal);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const responseBody = await getResponseSummary(response);
      const httpError = new Error(`Backup download returned HTTP ${response.statusCode}`);
      httpError.httpStatus = response.statusCode;
      throw addDownloadDiagnostic(httpError, task, url, node, responseBody);
    }

    const contentLength = Number(response.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > expectedSize) {
      response.destroy();
      const error = new Error(`Backup response exceeds declared size: ${contentLength}>${expectedSize}`);
      error.code = 'BACKUP_DOWNLOAD_TOO_LARGE';
      error.terminal = true;
      throw error;
    }
    let receivedBytes = 0;
    const progressStream = new Transform({
      transform(chunk, encoding, callback) {
        if (chunk.length > expectedSize - receivedBytes) {
          const error = new Error(`Backup stream exceeds declared size of ${expectedSize} bytes`);
          error.code = 'BACKUP_DOWNLOAD_TOO_LARGE';
          error.terminal = true;
          error.receivedSize = receivedBytes + chunk.length;
          callback(error);
          return;
        }
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
    const responseBody = getUnexpectedFilePreview(partialPath, actualSize, 4096);
    const nodeResponseError = getFluxNodeResponseError(responseBody, response.statusCode);
    if (nodeResponseError) {
      nodeResponseError.receivedSize = actualSize;
      throw nodeResponseError;
    }
    if (actualSize !== expectedSize) {
      const sizeError = new Error(`File size mismatch ${expectedSize}<>${actualSize}`);
      sizeError.receivedSize = actualSize;
      sizeError.responseBody = responseBody;
      throw sizeError;
    }

    fs.renameSync(partialPath, finalPath);
    log.info(`${filename} downloaded successfully for task ${task.taskId}.`);
    task.status = { state: 'downloading', message: 'download finished', progress: 100 };
    task.downloaded = true;
    return true;
  } catch (error) {
    if (controller.signal.aborted) {
      error.code = 'BACKUP_DOWNLOAD_TIMEOUT';
      error.message = `Backup download exceeded its ${config.backupDownloadTimeoutMs}ms deadline`;
    }
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
    clearTimeout(deadline);
    releaseDownloadCapacity(task.taskId);
  }
}

module.exports = {
  fileExists,
  deleteFile,
  getRemoteFileSize,
  getTaskAuthHeader,
  getTaskRequestAuthentication,
  getFluxDriveMaxFileSizeBytes,
  validateFluxDriveFileSize,
  downloadFileFromHost,
};
