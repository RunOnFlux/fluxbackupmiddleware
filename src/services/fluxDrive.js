/* eslint-disable no-param-reassign */
const axios = require('axios');
const http = require('http');
const https = require('https');
const FormData = require('form-data');
const { URL } = require('url');
const fs = require('fs');
const log = require('../lib/log');
const Vault = require('./Vault');
const taskFileStorage = require('./utils/taskFileStorage');

/**
 * Builds a full URL for FluxDrive API endpoints.
 * Handles both URLs with and without protocol prefix.
 *
 * @param {string} serverUrl - The FluxDrive server URL (with or without protocol)
 * @param {string} endpoint - The API endpoint path
 * @returns {string} - The full URL with protocol
 */
function buildFluxDriveUrl(serverUrl, endpoint) {
  if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) {
    return `${serverUrl}${endpoint}`;
  }
  return `http://${serverUrl}${endpoint}`;
}

function getUploadFailureReason(result, fallback) {
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  if (typeof result?.message === 'string' && result.message.length > 0) {
    return result.message;
  }
  if (typeof result?.error === 'string' && result.error.length > 0) {
    return result.error;
  }
  if (typeof result?.reason === 'string' && result.reason.length > 0) {
    return result.reason;
  }
  if (typeof result?.data === 'string' && result.data.length > 0) {
    return result.data;
  }
  if (typeof result?.data?.message === 'string' && result.data.message.length > 0) {
    return result.data.message;
  }
  return fallback;
}

function logUploadFailure(file, fileName, fileSize, reason, statusCode = null) {
  const sizeMiB = (fileSize / (1024 * 1024)).toFixed(2);
  const status = statusCode === null ? '' : `, httpStatus=${statusCode}`;
  log.error(`FluxDrive upload failed: taskId=${file.taskId}, appname=${file.appname}, file=${fileName}, size=${fileSize} bytes (${sizeMiB} MiB)${status}, reason=${reason}`);
}

function createUploadError(reason, endpoint, httpStatus = null, errorCode = null) {
  const error = new Error(reason);
  error.diagnostic = {
    check: 'FluxDrive upload',
    outcome: 'failed',
    endpoint,
    node: new URL(endpoint).origin,
    httpStatus,
    errorCode,
    detail: reason,
  };
  return error;
}

function getInventoryEntries(response) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return null;
  if (response.status && response.status !== 'success') return null;

  const candidates = [
    response.files,
    response.data,
    response.data?.files,
    response.result,
    response.result?.files,
    response.result?.entries,
  ];
  return candidates.find((candidate) => Array.isArray(candidate)) || null;
}

function getInventoryEntryHash(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  return entry.hash || entry.Hash || entry.cid || entry.Cid || entry.CID || null;
}

function inventoryHasMorePages(response) {
  if (!response || typeof response !== 'object') return false;
  const containers = [response, response.data, response.result].filter(
    (value) => value && typeof value === 'object',
  );
  return containers.some((value) => (
    value.hasMore === true
    || value.has_more === true
    || Boolean(value.nextCursor)
    || Boolean(value.next_cursor)
    || Boolean(value.nextPage)
  ));
}

/**
 * Parses a successful FluxDrive file-list response into an authoritative hash set.
 * Unknown response shapes are rejected so they cannot be mistaken for an empty drive.
 *
 * @param {Object|Array} response - Raw response from /api/v0/ls
 * @returns {{success: boolean, hashes: Set<string>, message?: string}}
 */
function parseFileInventory(response) {
  if (inventoryHasMorePages(response)) {
    return {
      success: false,
      hashes: new Set(),
      message: 'FluxDrive returned a paginated file list with more pages',
    };
  }

  const entries = getInventoryEntries(response);
  if (!entries) {
    return {
      success: false,
      hashes: new Set(),
      message: 'FluxDrive returned an unrecognized file-list response',
    };
  }

  const hashes = new Set();
  let unrecognizedEntries = 0;
  entries.forEach((entry) => {
    const hash = getInventoryEntryHash(entry);
    if (typeof hash === 'string' && hash.length > 0) {
      hashes.add(hash);
    } else {
      unrecognizedEntries += 1;
    }
  });
  if (unrecognizedEntries > 0) {
    return {
      success: false,
      hashes: new Set(),
      message: `FluxDrive file list contained ${unrecognizedEntries} unrecognized entries`,
    };
  }
  return { success: true, hashes };
}

/**
 * Retrieves the status from the FluxDrive server.
 *
 * @async
 * @returns {Promise<Object|null>} - A promise that resolves to the status data if the request is successful, or null if the request fails.
 */
async function getStatus() {
  const ZELID = await Vault.getKey('zelid');
  const API_KEY = await Vault.getKey('apikey');
  const FD_SERVER = await Vault.getKey('fluxDriveServer');
  try {
    const result = await axios({
      method: 'post',
      url: buildFluxDriveUrl(FD_SERVER, '/api/v0/status'),
      headers: {
        Authorization: `Basic ${Buffer.from(`${ZELID}:${API_KEY}`).toString('base64')}`,
      },
    });
    return result.data;
  } catch (e) {
    log.error(e);
    return null;
  }
}
/**
 * Removes given hash.
 *
 * @async
 * @returns {Promise<Object|null>} - A promise that resolves to the status data if the request is successful, or null if the request fails.
 */
async function removeFile(hash) {
  const ZELID = await Vault.getKey('zelid');
  const API_KEY = await Vault.getKey('apikey');
  const FD_SERVER = await Vault.getKey('fluxDriveServer');
  try {
    const result = await axios({
      method: 'post',
      url: buildFluxDriveUrl(FD_SERVER, '/api/v0/rm'),
      data: { hash },
      headers: {
        Authorization: `Basic ${Buffer.from(`${ZELID}:${API_KEY}`).toString('base64')}`,
      },
    });
    return result.data;
  } catch (e) {
    log.error(e);
    return {
      status: 'error',
      success: false,
      httpStatus: e.response?.status || null,
      message: getUploadFailureReason(e.response?.data, e.message || 'FluxDrive removal request failed'),
    };
  }
}

/**
 * Retrieves filelist from the FluxDrive server.
 *
 * @async
 * @returns {Promise<Object|null>} - A promise that resolves to the file list if the request is successful, or null if the request fails.
 */
async function getFileList() {
  const ZELID = await Vault.getKey('zelid');
  const API_KEY = await Vault.getKey('apikey');
  const FD_SERVER = await Vault.getKey('fluxDriveServer');
  try {
    const result = await axios({
      method: 'post',
      url: buildFluxDriveUrl(FD_SERVER, '/api/v0/ls'),
      headers: {
        Authorization: `Basic ${Buffer.from(`${ZELID}:${API_KEY}`).toString('base64')}`,
      },
    });
    return result.data;
  } catch (e) {
    log.error(e);
    return null;
  }
}

async function getFileInventory() {
  const response = await getFileList();
  return parseFileInventory(response);
}

/**
 * Removes a file from FluxDrive.
 *
 * The list endpoint is paginated/capped and therefore cannot prove that a hash
 * is absent. Only an explicit successful removal response is authoritative.
 *
 * @param {string} hash - FluxDrive file hash
 * @returns {Promise<Object>} - FluxDrive removal result
 */
async function removeFileVerified(hash) {
  return removeFile(hash);
}

/**
 * Uploads a file to the FluxDrive server.
 *
 * @async
 * @param {Object} file - The task object from task Queue.
 * @returns {Promise<Object>} - A promise that resolves to the server's response when the file is successfully uploaded.
 * @throws Will throw an error if the upload fails.
 */
async function uploadFile(file) {
  const { filename } = file;
  const filePath = taskFileStorage.getTaskFilePath(file);
  const ZELID = await Vault.getKey('zelid');
  const API_KEY = await Vault.getKey('apikey');
  const FD_SERVER = await Vault.getKey('fluxDriveServer');
  const form = new FormData();
  const fileName = filename;
  const fileSize = fs.statSync(filePath).size;
  const fileStream = fs.createReadStream(filePath);
  form.append('file', fileStream, { filename: fileName, knownLength: fileSize });

  const fullUrl = buildFluxDriveUrl(FD_SERVER, '/api/v0/put');
  const parsedUrl = new URL(fullUrl);
  const isHttps = parsedUrl.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    port: parsedUrl.port,
    method: 'POST',
    headers: {
      ...form.getHeaders(),
      Authorization: `Basic ${Buffer.from(`${ZELID}:${API_KEY}`).toString('base64')}`,
    },
  };
  let progress = 0;
  fileStream.on('data', (chunk) => {
    progress += chunk.length;
    file.status = { state: 'uploading', message: 'Uploading file to FluxDrive', progress: Number(((progress / fileSize) * 100).toFixed(2)) };
    // console.log(file.status);
  });
  return new Promise((resolve, reject) => {
    const req = httpModule.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        let result;
        try {
          result = JSON.parse(data);
        } catch (error) {
          const reason = `Invalid FluxDrive response: ${error.message}`;
          logUploadFailure(file, fileName, fileSize, reason, res.statusCode);
          file.status = { state: 'failed', message: reason, progress: 0 };
          reject(createUploadError(reason, fullUrl, res.statusCode));
          return;
        }
        // console.log(result);
        if (res.statusCode >= 200 && res.statusCode < 300 && result?.hash) {
          console.log(`${fileName} uploaded successfully!`);
          file.uploaded = true;
          file.hash = result.hash;
          // console.log(file);
          resolve(result);
        } else {
          const reason = getUploadFailureReason(result, 'FluxDrive did not return an upload hash');
          logUploadFailure(file, fileName, fileSize, reason, res.statusCode);
          file.status = { state: 'failed', message: reason, progress: 0 };
          reject(createUploadError(reason, fullUrl, res.statusCode));
        }
      });
    });

    req.on('error', (error) => {
      const reason = error.message || 'FluxDrive request failed';
      logUploadFailure(file, fileName, fileSize, reason);
      file.status = { state: 'failed', message: reason, progress: 0 };
      reject(createUploadError(reason, fullUrl, null, error.code || null));
    });

    form.pipe(req);
  });
}

async function getFile(req, res) {
  const ZELID = await Vault.getKey('zelid');
  const API_KEY = await Vault.getKey('apikey');
  const FD_SERVER = await Vault.getKey('fluxDriveServer');
  let { filename } = req.params;
  filename = filename || req.query.filename;
  try {
    axios({
      method: 'post',
      url: buildFluxDriveUrl(FD_SERVER, '/api/v0/cat'),
      data: { hash: filename },
      responseType: 'stream',
      timeout: 60000,
      headers: {
        Authorization: `Basic ${Buffer.from(`${ZELID}:${API_KEY}`).toString('base64')}`,
      },
    }).then((response) => {
      if ('content-type' in response.data.headers) {
        res.setHeader('Content-Type', response.data.headers['content-type']);
      } else {
        res.setHeader('Content-Type', 'application/x-tar');
      }
      res.set('Content-Disposition', `attachment; filename=${filename}`); // Set the file name for download
      response.data.pipe(res); // Pipe the file stream to the response
    }).catch((error) => {
      log.error(error);
      res.status(500).send('Error fetching the file');
    });
  } catch (e) {
    log.error(e);
    return null;
  }
  return null;
}

async function getUsedStorage() {
  const result = await getStatus();
  return result.result?.storage_used;
}

module.exports = {
  getStatus,
  getUsedStorage,
  getFileList,
  getFileInventory,
  parseFileInventory,
  uploadFile,
  getFile,
  removeFile,
  removeFileVerified,
};
