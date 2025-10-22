/* eslint-disable no-param-reassign */
const fs = require('fs');
const http = require('http');
const https = require('https');
const log = require('../lib/log');
const config = require('../../config/default');
const fluxOS = require('./fluxOsService');
const Vault = require('./Vault');

const path = config.storagePath;
// const apiPath = config.hostAPIPath;

// Ensure the storage directory exists on module load
if (!fs.existsSync(path)) {
  fs.mkdirSync(path, { recursive: true });
  log.info(`Created storage directory: ${path}`);
}

/**
 * checks if a file exists
 *
 * @param {string} fileName - The task object.
 */
function fileExists(filename) {
  return fs.existsSync(path + filename);
}

/**
 * Deletes given filename
 *
 * @param {string} fileName - The task object.
 * @throws Will throw an error if it fails.
 */
function deleteFile(fileName) {
  try {
    fs.unlinkSync(path + fileName);
    log.info(`"${fileName}" has been deleted.`);
  } catch (error) {
    log.error(`Error deleting file "${fileName}": ${error.message}`);
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
  const { filesize } = task;
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
  log.info(`Downloading ${filename} from ${url.href}`);
  return new Promise((resolve, reject) => {
    try {
      const headers = { zelidauth };
      const file = fs.createWriteStream(path + filename);
      let receivedBytes = 0;
      const get = url.protocol.startsWith('https:') ? https.get : http.get;
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
      };
      // console.log(options);
      get(options, (response) => {
        // Check if the server responded with a redirect
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.headers.location = new URL(response.headers.location, url).href;
          // Start a new download using the redirected URL
          downloadFileFromHost(task).then(resolve).catch(reject);
          return;
        }
        const totalBytes = response.headers['content-length'];

        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          const percentCompleted = (receivedBytes / totalBytes) * 100;
          // log.info(`Downloading ${filename}: ${percentCompleted.toFixed(2)}%`);
          task.status = { state: 'downloading', message: 'Fetching file from node', progress: Number(percentCompleted.toFixed(2)) };
          // console.log(task.status);
        });

        response.pipe(file);

        file.on('finish', () => {
          // Close the file stream first and wait for it to complete
          file.close((closeErr) => {
            if (closeErr) {
              log.error(`Error closing file ${filename}:`, closeErr);
              task.status = { state: 'failed', message: 'Error closing file', progress: 0 };
              reject(closeErr);
              return;
            }

            // Now check if the file exists and verify its size
            try {
              if (!fs.existsSync(path + filename)) {
                const errorMessage = `File ${path + filename} does not exist after download.`;
                log.error(errorMessage);
                task.status = { state: 'failed', message: 'File does not exist after download', progress: 0 };
                task.downloaded = false;
                reject(new Error(errorMessage));
              }
              const stats = fs.statSync(path + filename);
              console.log(`File size: ${stats.size} bytes`);

              if (filesize !== stats.size) {
                log.error(`File size mismatch ${filesize}<>${stats.size}`);
                task.status = { state: 'failed', message: 'File size mismatch', progress: 0 };
                task.downloaded = false;
                fs.unlink(path + filename, (err) => {
                  if (err) log.error(`Failed to delete file ${filename}:`, err);
                });
                reject(new Error('File size mismatch'));
              } else {
                // File downloaded successfully and size matches
                log.info(`${filename} downloaded successfully from node.`);
                task.status = { state: 'downloading', message: 'download finished', progress: 100 };
                task.downloaded = true;
                resolve(true);
              }
            } catch (statError) {
              log.error(`Error checking file stats for ${filename}:`, statError);
              task.status = { state: 'failed', message: 'Failed to verify downloaded file', progress: 0 };
              task.downloaded = false;
              reject(statError);
            }
          });
        });

        file.on('error', (error) => {
          log.error(`Downloading ${filename} from host failed.`);
          task.status = { state: 'failed', message: 'Fetching file from node failed', progress: 0 };
          fs.unlink(path + filename, (err) => {
            if (err) log.error(`Failed to delete file ${filename}:`, err);
          });
          reject(error.message);
        });
      });
    } catch (err) {
      log.error('Download failed.');
      log.error(err);
      reject(err.message);
    }
  });
}

module.exports = {
  fileExists,
  deleteFile,
  downloadFileFromHost,
};
