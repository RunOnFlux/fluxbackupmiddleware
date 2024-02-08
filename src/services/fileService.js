/* eslint-disable no-param-reassign */
const fs = require('fs');
const http = require('http');
const https = require('https');
const log = require('../lib/log');
const config = require('../../config/default');

const path = config.storagePath;
const apiPath = config.hostAPIPath;

function fileExists(filename) {
  return fs.existsSync(path + filename);
}

/**
* [deleteFile]
*/
function deleteFile(fileName) {
  try {
    fs.unlinkSync(path + fileName);
    log.info(`"${fileName}" has been deleted.`);
  } catch (error) {
    log.error(`Error deleting file "${fileName}": ${error.message}`);
  }
}

async function downloadFileFromHost(task) {
  return new Promise((resolve, reject) => {
    const { filename } = task;
    const url = new URL(`${task.host}${apiPath}${filename}`);
    const headers = {};
    const file = fs.createWriteStream(path + filename);
    let receivedBytes = 0;
    const get = url.protocol.startsWith('https:') ? https.get : http.get;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
    };
    console.log(options);
    // eslint-disable-next-line consistent-return
    get(options, (response) => {
      // Check if the server responded with a redirect
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.headers.location = new URL(response.headers.location, url).href;
        // Start a new download using the redirected URL
        return downloadFileFromHost(task);
      }
      const totalBytes = response.headers['content-length'];

      response.on('data', (chunk) => {
        receivedBytes += chunk.length;
        const percentCompleted = (receivedBytes / totalBytes) * 100;
        // log.info(`Downloading ${filename}: ${percentCompleted.toFixed(2)}%`);
        task.status = { state: 'downloading', message: 'Fetching file from host', progress: percentCompleted.toFixed(2) };
        console.log(task.status);
      });

      response.pipe(file);

      file.on('finish', () => {
        log.info(`${filename} downloaded successfully from host.`);
        task.status = { state: 'downloading', message: 'download finished', progress: 100 };
        task.downloaded = true;
        file.close(resolve(true));
      });

      file.on('error', (error) => {
        log.error(`Downloading ${filename} from host failed.`);
        task.status = { state: 'failed', message: 'Fetching file from host failed', progress: 0 };
        fs.unlink(path + filename);
        reject(error.message);
      });
    });
  });
}

module.exports = {
  fileExists,
  deleteFile,
  downloadFileFromHost,
};
