/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
const DBClient = require('./utils/DBClient');
const log = require('../lib/log');
const config = require('../../config/default');
const idService = require('./idService');
const messageHelper = require('./utils/messageHelper');
const fileManager = require('./fileService');
const fluxDrive = require('./fluxDrive');
const fluxOS = require('./fluxOsService');

let dbCli = null;

const taskQueue = new Map();

/**
 * This function runs a task with a given ID. It updates the task status in the database,
 * downloads the file associated with the task if it's not already downloaded, uploads the file
 * to FluxDrive if it's not already uploaded, and removes the local file once it's uploaded.
 * If any step fails, it increments the task's fail count and logs the failure.
 *
 * @async
 * @param {string|number} id - The ID of the task to run.
 * @throws Will throw an error if the task fails.
 */
async function runTask(id) {
  log.info(`ruuning task ${id}`);
  const task = taskQueue.get(id);
  try {
    task.startTime = Math.floor(Date.now() / 1000);
    task.status = { state: 'started', message: 'backup to FluxDrive started', progress: 0 };
    await dbCli.updateTask(task);
    // check if file is downloaded
    if (!task.downloaded || task.localRemoved) {
      // download the file
      log.info(`downloading task ${id}.`);
      task.status = { state: 'downloading', message: 'fetching file from node', progress: 0 };
      await dbCli.updateTask(task);
      await fileManager.downloadFileFromHost(task);
      // task.status = { state: 'downloading', message: 'fetching file from node', progress: 100 };
      await dbCli.updateTask(task);
    }
    // check if file is uploaded
    if (!task.uploaded) {
      // upload the file
      log.info(`uploading task ${id}.`);
      task.status = { state: 'uploading', message: 'uploading file to FluxDrive', progress: 0 };
      await dbCli.updateTask(task);
      await fluxDrive.uploadFile(task);
      // task.status = { state: 'uploading', message: 'uploading file to FluxDrive', progress: 100 };
      await dbCli.updateTask(task);
    }
    // check if the file is removed locally
    if (fileManager.fileExists(task.filename) || !task.localRemoved) {
      // remove the file locally
      log.info(`removing local file for task ${id}.`);
      await fileManager.deleteFile(task.filename);
      task.localRemoved = true;
      await dbCli.updateTask(task);
    }
    // ask remote server to remove the file

    // mark the task as done and remove from queue
    log.info(`task ${id} finished.`);
    task.status = { state: 'finished', message: 'finished', progress: 100 };
    task.finishTime = Math.floor(Date.now() / 1000);
    task.extra = '';
    await dbCli.updateTask(task);
    taskQueue.delete(id);
  } catch (error) {
    task.fails += 1;
    await dbCli.updateTask(task);
    log.error(`task ${id} failed.${JSON.stringify(error)}`);
  }
}

/**
 * This function updates the task queue. It first removes any tasks from the queue that have been running for more than an hour.
 * Then, if the queue has space, it fetches the latest remaining tasks from the database and adds them to the queue.
 * It only fetches tasks that have not finished and have failed less than three times.
 * It then runs each newly added task.
 *
 * @async
 * @throws Will throw an error if the database query fails.
 */
async function updateQueue() {
  // remove failed tasks from queue
  const now = Math.floor(Date.now() / 1000);
  const failTime = 60 * 60; // 1 hour
  taskQueue.forEach((value, key) => {
    if (now - value.startTime > failTime) {
      log.info(`deleting ${key} from queue.`);
      taskQueue.delete(key);
    }
  });
  // check if queue has space
  if (taskQueue.size < config.maxConcurrentTasks) {
    // read latest remaining tasks from db
    const emptySlots = config.maxConcurrentTasks - taskQueue.size;
    const records = await dbCli.execute(`select * from tasks where finishTime=0 and fails<3 order by timestamp limit ${Number(emptySlots)}`);
    if (records.length) log.debug(`${records.length} failed tasks, retrying...`);
    for (let i = 0; i < records.length; i += 1) {
      if (!taskQueue.has(records[i].taskId)) {
        // add task to the queue
        taskQueue.set(Number(records[i].taskId), records[i]);
        // run task
        log.debug(`retrying task ${records[i].taskId}`);
        runTask(Number(records[i].taskId));
      }
    }
    // console.log(taskQueue.entries());
  }
}

/**
 * Checks expired apps and removes all backup files linked to it from FluxDrive.
 *
 * @async
 * @throws Will throw an error if the database query fails.
 */
async function checkExpiredApps() {
  try {
    log.info('checkExpiredApps...');
    let expireHeight = await fluxOS.getBlockHeight();
    if (expireHeight !== false && expireHeight > 1000) {
      expireHeight -= 720 * 7; // 7 days
      // get apps that have been expired more than 7 days
      const records = await dbCli.execute(`select * from tasks where removedFromFluxdrive = 0 and uploaded = 1 and appExpireHeight > 0  and appExpireHeight < ${Number(expireHeight)} order by appExpireHeight ASC limit 10`);
      // eslint-disable-next-line no-restricted-syntax
      for (record of records) {
        // check if they have been extended
        const appSpecs = await fluxOS.getAppSpecs(record.appname, true);
        if (appSpecs && appSpecs !== 'Application not found' && appSpecs.expire + appSpecs.height !== record.appExpireHeight) {
          if (appSpecs.owner === record.owner) {
            log.info(`id: ${record.taskId}, appname: ${record.appname} expire height updated.`);
            record.appExpireHeight = appSpecs.expire + appSpecs.height;
            await dbCli.updateTask(record);
          } else {
            log.info(`id: ${record.taskId}, appname: ${record.appname} has a new owner. removing file from FluxDrive`);
            await fluxDrive.removeFile(record.hash);
            await dbCli.softRemoveTask(record.taskId);
          }
        }
        if (appSpecs && appSpecs === 'Application not found') {
          log.info(`id: ${record.taskId}, appname: ${record.appname}, hash: ${record.hash} removed from FluxDrive.`);
          await fluxDrive.removeFile(record.hash);
          await dbCli.softRemoveTask(record.taskId);
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Initializes the backup service and DB.
 *
 * @async
 */
async function init() {
  log.info('Initiating Database...');
  dbCli = await DBClient.createClient();
  await dbCli.checkSchema();
  setInterval(async () => {
    await updateQueue();
  }, 10 * 1000);
  await dbCli.checkSchema();
  setInterval(async () => {
    await checkExpiredApps();
  }, 60 * 60 * 1000);
}

/**
 * Checks if a given string is a valid URL.
 *
 * @param {string} string - The string to check.
 * @returns {boolean} - Returns true if the string is a valid URL, false otherwise.
 */
function isValidUrl(string) {
  try {
    // eslint-disable-next-line no-new
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * This function registers a backup task. It first extracts parameters from the request,
 * validates the user session, and checks the validity of the provided parameters.
 * It then checks if the user has enough storage quota and if the task is a duplicate.
 * If all checks pass, it adds the task to the database and runs the task if there is space in the queue.
 * If any step fails, it logs the error and sends an error message as the response.
 *
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @throws Will throw an error if the user session is invalid, parameters are invalid, user quota is full, task is a duplicate, or database operation fails.
 */
async function registerBackupTask(req, res) {
  let { appname } = req.body;
  appname = appname || req.query.appname;
  let { component } = req.body;
  component = component || req.query.component;
  let { filename } = req.body;
  filename = filename || req.query.filename;
  let { timestamp } = req.body;
  timestamp = timestamp || req.query.timestamp;
  let { host } = req.body;
  host = host || req.query.host;
  let { filesize } = req.body;
  filesize = filesize || req.query.filesize;
  try {
    // validate session
    const owner = await idService.verifyUserSession(req.headers);
    if (owner === false) {
      throw new Error('Unauthorized access. Session expired.');
    }
    // validate app and component name
    if (!appname || !component) {
      throw new Error('Invalid app or component name.');
    }
    if (!await fluxOS.verifyAppOwner(owner, appname)) {
      throw new Error('Unauthorized. Access denied.');
    }
    // validate timestamp
    const numberpRegex = /^\d+$/;
    if (!numberpRegex.test(timestamp)) {
      throw new Error('timestamp is not valid');
    }
    // validate filename
    if (filename.length < 3 || filename.includes('/')) {
      throw new Error('filename is not valid');
    }
    // validate filesize
    if (!numberpRegex.test(filesize)) {
      throw new Error('filesize is not valid');
    }
    // validate host
    if (!isValidUrl(host)) {
      throw new Error('host url is not valid');
    }
    // get app expire height
    const appExpireHeight = await fluxOS.getAppExpireHeight(appname);
    if (appExpireHeight === false) {
      throw new Error("can't verify app specs, please try again");
    }
    const extra = req.headers.zelidauth;
    // check if user has enough storage quota
    const totalUsed = await dbCli.execute('select sum(filesize) as totalUsed from tasks where owner=? and removedFromFluxdrive=0', [owner]);
    let taskId = null;
    let userTotalUse = 0;
    if (totalUsed.length > 0) userTotalUse = totalUsed[0].totalUsed;
    if (userTotalUse > config.quotaPerUser * 1024 * 1024 * 1024) {
      throw new Error('user quota is full.');
    }
    // check number of files on FD for the appname
    const totalFiles = await dbCli.execute('select count(*) as fileCount from tasks where appname=? and owner=? and removedFromFluxdrive=0', [appname, owner]);
    if (totalFiles.length > 0 && totalFiles[0].fileCount > config.maxFilesPerApp) {
      throw new Error(`Upload limit reached, max ${config.maxFilesPerApp} files allowed per app.`);
    }
    // check if task is a duplicate
    const record = await dbCli.execute('select * from tasks where owner=? and timestamp=? and appname=? and component=?', [owner, timestamp, appname, component]);
    if (record.length > 0 && record[0].uploaded === 1) {
      throw new Error('Checkpoint has already been uploaded to FluxDrive.');
    } else if (record.length > 0 && record[0].uploaded === 0) {
      // resume the task if there is space in queue
      if (taskQueue.size < config.maxConcurrentTasks) {
        taskId = record[0].taskId;
        const task = await dbCli.getTask(taskId);
        if (task) {
          task.extra = req.headers.zelidauth;
          task.removedFromFluxDrive = 0;
          dbCli.updateTask(task);
          taskQueue.set(Number(taskId), task);
          runTask(Number(taskId));
        }
      }
    } else {
      // add task to the db
      const newTask = {
        owner, timestamp, filename, appname, component, filesize, host, extra, appExpireHeight,
      };
      const result = await dbCli.addNewTask(newTask);
      taskId = result.insertId;
      // run the task if there is space in queue
      if (taskQueue.size < config.maxConcurrentTasks) {
        const task = await dbCli.getTask(taskId);
        if (task) {
          taskQueue.set(Number(taskId), task);
          runTask(Number(taskId));
        }
      }
    }
    const phraseResponse = messageHelper.createDataMessage({ taskId });
    res.json(phraseResponse);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * This function retrieves a list of backup tasks for a specific application.
 * It first extracts the application name from the request, validates the user session, and checks the validity of the application name.
 * If any step fails, it logs the error and sends an error message as the response.
 *
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @throws Will throw an error if the user session is invalid, application name is invalid, or database operation fails.
 */
async function getBackupList(req, res) {
  let { appname } = req.body;
  appname = appname || req.query.appname;

  try {
    // validate session
    const owner = await idService.verifyUserSession(req.headers);
    if (owner === false) {
      throw new Error('Unauthorized access. Session expired.');
    }
    // validate app and component name
    if (!appname) {
      throw new Error('Invalid appname.');
    }
    if (!await fluxOS.verifyAppOwner(owner, appname)) {
      throw new Error('Unauthorized. Access denied.');
    }
    const result = await dbCli.getUserBackups(owner, appname);
    const checkpoints = [];
    if (Array.isArray(result)) {
      const temp = {};
      let i = 0;
      for (; i < result.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(temp, result[i].timestamp)) {
          temp[result[i].timestamp].components.push({ component: result[i].component, file_url: `https://jetpack2_38080.app.runonflux.io/ipfs/${result[i].hash}`, file_size: result[i].filesize });
        } else {
          if (i > 0) {
            checkpoints.push({ timestamp: result[i - 1].timestamp, components: temp[result[i - 1].timestamp].components });
          }
          temp[result[i].timestamp] = { components: [{ component: result[i].component, file_url: `https://jetpack2_38080.app.runonflux.io/ipfs/${result[i].hash}`, file_size: result[i].filesize }] };
        }
      }
      checkpoints.push({ timestamp: result[i - 1].timestamp, components: temp[result[i - 1].timestamp].components });
    }
    res.json({ status: 'success', checkpoints });
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * Returns task status.
 *
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @throws Will throw an error if the user session is invalid, taskId is invalid, or database operation fails.
 */
async function getTaskStatus(req, res) {
  let { taskId } = req.body;
  taskId = taskId || req.query.taskId;

  try {
    // validate session
    const owner = await idService.verifyUserSession(req.headers);
    if (owner === false) {
      throw new Error('Unauthorized access. Session expired.');
    }
    // validate app and component name
    if (!taskId) {
      throw new Error('taskId not provided.');
    }
    console.log(taskQueue.entries());
    let task = taskQueue.get(Number(taskId));
    if (!task) {
      task = await dbCli.getTask(taskId);
    }

    if (!task) {
      throw new Error('task does not exist.');
    }
    res.json({ status: 'success', data: { taskId: task.taskId, status: task.status } });
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * Removes the provided checkpoint and it's files stored on FluxDrive.
 *
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @throws Will throw an error if the user session is invalid, taskId is invalid, or database operation fails.
 */
async function removeCheckpoint(req, res) {
  let { timestamp } = req.body;
  timestamp = timestamp || req.query.timestamp;
  let { appname } = req.body;
  appname = appname || req.query.appname;

  try {
    // validate session
    const owner = await idService.verifyUserSession(req.headers);
    if (owner === false) {
      throw new Error('Unauthorized access. Session expired.');
    }
    // validate timestamp
    if (!timestamp) {
      throw new Error('timestamp not provided.');
    }

    // validate appname
    if (!appname) {
      throw new Error('appname not provided.');
    }
    if (!await fluxOS.verifyAppOwner(owner, appname)) {
      throw new Error('Unauthorized. Access denied.');
    }
    const checkpoint = await dbCli.getUserCheckpoint(owner, appname, timestamp);

    if (!checkpoint) {
      throw new Error('checkpoint does not exist.');
    }
    const removedFiles = [];
    if (Array.isArray(checkpoint)) {
      for (let i = 0; i < checkpoint.length; i += 1) {
        if (checkpoint[i].hash) {
          // eslint-disable-next-line no-await-in-loop
          await fluxDrive.removeFile(checkpoint[i].hash);
          // eslint-disable-next-line no-await-in-loop
          await dbCli.softRemoveTask(checkpoint[i].taskId);
          removedFiles.push({
            timestamp: checkpoint[i].timestamp, hash: checkpoint[i].hash, filename: checkpoint[i].filename, filesize: checkpoint[i].filesize,
          });
        }
      }
    }
    if (removedFiles.length) {
      res.json({ status: 'success', data: { removedFiles } });
    } else {
      res.json({ status: 'error', data: { message: 'No file removed' } });
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

module.exports = {
  init,
  registerBackupTask,
  getBackupList,
  getTaskStatus,
  removeCheckpoint,
};
