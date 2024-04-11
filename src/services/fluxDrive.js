/* eslint-disable no-param-reassign */
const axios = require('axios');
const http = require('http');
const FormData = require('form-data');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const log = require('../lib/log');
const Vault = require('./Vault');
const config = require('../../config/default');

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
      url: `http://${FD_SERVER}/api/v0/status`,
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
      url: `http://${FD_SERVER}/api/v0/rm?arg=${hash}`,
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
      url: `http://${FD_SERVER}/api/v0/ls`,
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
 * Uploads a file to the FluxDrive server.
 *
 * @async
 * @param {Object} file - The task object from task Queue.
 * @returns {Promise<Object>} - A promise that resolves to the server's response when the file is successfully uploaded.
 * @throws Will throw an error if the upload fails.
 */
async function uploadFile(file) {
  const { filename } = file;
  const filePath = config.storagePath + filename;
  const ZELID = await Vault.getKey('zelid');
  const API_KEY = await Vault.getKey('apikey');
  const FD_SERVER = await Vault.getKey('fluxDriveServer');
  const form = new FormData();
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const fileStream = fs.createReadStream(filePath);
  form.append('file', fileStream);
  const {
    hostname, port,
  } = new URL(`http://${FD_SERVER}/api/v0/put`);

  const options = {
    hostname,
    path: '/api/v0/put',
    port,
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
    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        const result = JSON.parse(data);
        console.log(result);
        if (result.status === 'success') {
          console.log(`${fileName} uploaded successfully!`);
          file.uploaded = true;
          file.hash = result.files[0].hash;
          console.log(file);
        }
        resolve(result);
      });
    });

    req.on('error', (error) => {
      file.status = { state: 'failed', message: 'uploading file to FluxDrive failed', progress: 0 };
      reject(error);
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
      url: `http://${FD_SERVER}/api/v0/cat?arg=${filename}`,
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
  uploadFile,
  getFile,
  removeFile,
};
