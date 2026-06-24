/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
const axios = require('axios');
const DBClient = require('./utils/DBClient');
const log = require('../lib/log');
const config = require('../../config/default');
const idService = require('./idService');
const messageHelper = require('./utils/messageHelper');
const fileManager = require('./fileService');
const fluxDrive = require('./fluxDrive');
const fluxOS = require('./fluxOsService');
const Vault = require('./Vault');
const discordNotifier = require('./discordNotifier');

let dbCli = null;

const taskQueue = new Map();

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function createBackupFailure(reason, stage, taskFailures = []) {
  const error = new Error(reason);
  error.stage = stage;
  error.taskFailures = taskFailures;
  return error;
}

function inferFailureStage(error) {
  if (error.stage) return error.stage;

  const message = getErrorMessage(error);
  if (message.includes('secondary node')) return 'node_selection';
  if (message.includes('authenticate')) return 'node_auth';
  if (message.includes('app owner')) return 'app_owner';
  if (message.includes('create backup tasks')) return 'create_backup';
  if (message.includes('Could not queue backup')) return 'create_backup';
  if (message.includes('Timeout waiting for tasks')) return 'task_timeout';
  return 'automatic_backup';
}

function buildTaskFailure(task, taskId, reason) {
  return {
    taskId,
    component: task?.component || 'unknown',
    message: task?.status?.message || reason,
    fails: task?.fails || 0,
  };
}

async function collectTaskFailures(taskIds, reason) {
  const failures = [];
  for (let i = 0; i < taskIds.length; i += 1) {
    const taskId = taskIds[i];
    const task = await dbCli.getTask(taskId);
    failures.push(buildTaskFailure(task, taskId, reason));
  }
  return failures;
}

function getRegistrationErrorFromResponse(data) {
  if (!data) {
    return 'No response from backup task registration';
  }

  if (data.status === 'error' && data.data) {
    return data.data.message || 'Backup task registration was rejected';
  }

  if (data.status === 'success' && data.data) {
    if (data.data.taskId) {
      return null;
    }
    return 'Backup task was not assigned an ID (database or queue issue)';
  }

  return 'Unexpected response from backup task registration';
}

function createRegistrationMocks() {
  let lastResponse = null;
  const mockRes = {
    json: (data) => {
      lastResponse = data;
    },
  };

  return {
    mockRes,
    getTaskId: () => (
      lastResponse?.status === 'success' && lastResponse?.data?.taskId
        ? lastResponse.data.taskId
        : null
    ),
    getError: () => getRegistrationErrorFromResponse(lastResponse),
  };
}

function summarizeRegistrationFailures(failures) {
  if (!failures.length) {
    return 'Backup files were created on the node but could not be queued for upload';
  }

  const messages = [...new Set(failures.map((failure) => failure.message))];
  const components = failures.map((failure) => failure.component).join(', ');

  if (messages.length === 1) {
    return `Could not queue backup for components [${components}]: ${messages[0]}`;
  }

  return `Could not queue backup for ${failures.length} components (${components})`;
}

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
    const message = getErrorMessage(error);
    if (!task.status || task.status.state !== 'failed') {
      task.status = { state: 'failed', message, progress: 0 };
    }
    task.fails += 1;
    await dbCli.updateTask(task);
    log.error(`task ${id} failed:`, error instanceof Error ? error : message);
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
  const failTime = 30 * 60; // 30 minutes
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
    const records = await dbCli.execute(`select * from tasks where finishTime=0 and fails<4 order by timestamp limit ${Number(emptySlots)}`);
    // if (records.length) log.debug(`${records.length} failed tasks, retrying...`);
    for (let i = 0; i < records.length; i += 1) {
      if (!taskQueue.has(records[i].taskId)) {
        // add task to the queue
        taskQueue.set(Number(records[i].taskId), records[i]);
        // run task
        log.debug(`retrying task ${records[i].taskId}`);
        runTask(Number(records[i].taskId));
      } else {
        // log.warn(`task ${records[i].taskId} already in queue.`);
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
      expireHeight -= 720 * 7 * 4; // 7 days
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
 * Syncs apps with Syncthing to the automatic_backups table.
 * Adds new apps found and increments expire_count for apps no longer present.
 *
 * @async
 * @throws Will throw an error if the database query fails.
 */
async function syncSyncthingApps() {
  try {
    log.info('Syncing Syncthing apps with automatic_backups table...');

    // Get all apps with Syncthing
    const syncthingApps = await fluxOS.getAppsWithSyncthing();

    if (!syncthingApps) {
      log.error('Failed to fetch apps with Syncthing');
      return;
    }

    // Get all apps currently in automatic_backups table
    const existingApps = await dbCli.execute('SELECT appname, expire_counter FROM automatic_backups');
    const existingAppNames = new Map(existingApps.map((app) => [app.appname, app.expire_counter]));

    // Check for new apps to add
    const newAppsToAdd = [];
    syncthingApps.forEach((app) => {
      if (!existingAppNames.has(app.appName)) {
        newAppsToAdd.push(app);
      }
    });

    // Add new apps to the table
    for (let i = 0; i < newAppsToAdd.length; i += 1) {
      const app = newAppsToAdd[i];
      const componentsJson = JSON.stringify(app.componentNames);
      const query = `INSERT INTO automatic_backups (appname, components, status, expire_counter, last_backup_timestamp)
                     VALUES (?, ?, 'pending', 0, 0)`;
      await dbCli.execute(query, [app.appName, componentsJson]);
      log.info(`Added new app ${app.appName} to automatic_backups`);
    }

    // Check for expired apps (in DB but not in current syncthing list)
    const currentAppNames = new Set(syncthingApps.map((app) => app.appName));
    const expiredApps = [];
    existingAppNames.forEach((expireCounter, appName) => {
      if (!currentAppNames.has(appName)) {
        expiredApps.push(appName);
      }
    });

    // Increment expire_counter for expired apps
    for (let i = 0; i < expiredApps.length; i += 1) {
      const appName = expiredApps[i];
      const query = 'UPDATE automatic_backups SET expire_counter = expire_counter + 1 WHERE appname = ?';
      await dbCli.execute(query, [appName]);
      log.info(`Incremented expire_counter for expired app ${appName}`);
    }

    log.info(`Sync complete. Added ${newAppsToAdd.length} new apps, marked ${expiredApps.length} as expired.`);
  } catch (error) {
    log.error('Error syncing Syncthing apps:', error);
  }
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
 * @param {Object} taskObj - Optional task object containing all required variables (appname, component, timestamp, host, filesize, owner, filename, backup_type)
 * @throws Will throw an error if the user session is invalid, parameters are invalid, user quota is full, task is a duplicate, or database operation fails.
 */
async function registerBackupTask(req, res, taskObj = null) {
  let appname;
  let component;
  let filename;
  let timestamp;
  let host;
  let filesize;
  let owner;
  let backupType;

  // If taskObj is provided, use its values; otherwise extract from request
  if (taskObj) {
    ({
      appname, component, timestamp, host, filesize, owner, filename, backup_type: backupType,
    } = taskObj);
    // Default to 'manual' if not specified in taskObj
    backupType = backupType || 'manual';
  } else {
    ({ appname } = req.body);
    appname = appname || req.query.appname;
    ({ component } = req.body);
    component = component || req.query.component;
    ({ filename } = req.body);
    filename = filename || req.query.filename;
    ({ timestamp } = req.body);
    timestamp = timestamp || req.query.timestamp;
    ({ host } = req.body);
    host = host || req.query.host;
    ({ filesize } = req.body);
    filesize = filesize || req.query.filesize;
    // Manual backups from API requests default to 'manual'
    backupType = 'manual';
  }

  try {
    // validate session only if owner is not provided via taskObj
    if (!owner) {
      owner = await idService.verifyUserSession(req.headers);
      if (owner === false) {
        throw new Error('Unauthorized access. Session expired.');
      }
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
    // When taskObj is provided, extra can be empty
    const extra = taskObj ? '' : req.headers.zelidauth;
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
      // Resume existing task; return its ID even if the queue is full (updateQueue will retry)
      taskId = record[0].taskId;
      if (taskQueue.size < config.maxConcurrentTasks) {
        const task = await dbCli.getTask(taskId);
        if (task) {
          task.extra = taskObj ? '' : req.headers.zelidauth;
          task.removedFromFluxDrive = 0;
          dbCli.updateTask(task);
          taskQueue.set(Number(taskId), task);
          runTask(Number(taskId));
        }
      }
    } else {
      // add task to the db
      const newTask = {
        owner, timestamp, filename, appname, component, filesize, host, extra, appExpireHeight, backup_type: backupType,
      };
      const result = await dbCli.addNewTask(newTask);
      taskId = result.insertId;
      if (!taskId) {
        throw new Error('Failed to create backup task in database');
      }
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

    // If owner is fluxteam, get the real app owner for backup retrieval
    let backupOwner = owner;
    const teamFluxID = await Vault.getKey('teamFluxID');
    if (owner === teamFluxID) {
      const realOwner = await fluxOS.getAppOwner(appname);
      if (realOwner) {
        backupOwner = realOwner;
        log.info(`Using real owner ${realOwner} for fluxteam backup retrieval of app ${appname}`);
      }
    }

    const result = await dbCli.getUserBackups(backupOwner, appname);
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

/**
 * Waits for all backup tasks to complete successfully.
 *
 * @async
 * @param {Array<number>} taskIds - Array of task IDs to monitor
 * @param {number} timeoutMinutes - Timeout in minutes (default: 60)
 * @returns {Promise<{success: boolean, failures: Array<Object>}>}
 */
async function waitForTasksToComplete(taskIds, timeoutMinutes = 60) {
  if (!taskIds || taskIds.length === 0) {
    log.info('No tasks to wait for');
    return { success: true, failures: [] };
  }

  const startTime = Date.now();
  const timeout = timeoutMinutes * 60 * 1000;
  const checkInterval = 30000; // Check every 30 seconds

  log.info(`Waiting for ${taskIds.length} tasks to complete: ${taskIds.join(', ')}`);

  while (Date.now() - startTime < timeout) {
    let allCompleted = true;
    let failureReason = null;
    let failedTaskId = null;

    for (let i = 0; i < taskIds.length; i += 1) {
      const taskId = taskIds[i];
      const task = await dbCli.getTask(taskId);

      if (!task) {
        failureReason = 'Task not found in database';
        failedTaskId = taskId;
        break;
      }

      if (task.fails >= 3) {
        failureReason = `Task failed ${task.fails} times`;
        failedTaskId = taskId;
        log.error(`Task ${taskId} failed ${task.fails} times: ${task.status?.message || failureReason}`);
        break;
      }

      if (task.finishTime === 0) {
        allCompleted = false;
        break;
      }

      if (task.uploaded !== 1) {
        failureReason = task.status?.message || 'Task did not upload successfully';
        failedTaskId = taskId;
        log.error(`Task ${taskId} did not upload successfully: ${failureReason}`);
        break;
      }
    }

    if (failureReason) {
      log.error('Some tasks failed. Aborting cleanup.');
      const failures = await collectTaskFailures(taskIds, failureReason);
      if (failedTaskId) {
        const failedIndex = failures.findIndex((failure) => failure.taskId === failedTaskId);
        if (failedIndex >= 0) {
          failures[failedIndex].message = failureReason;
        }
      }
      return { success: false, failures };
    }

    if (allCompleted) {
      log.info('All tasks completed successfully');
      return { success: true, failures: [] };
    }

    log.debug(`Still waiting for tasks to complete... (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`);
    await new Promise((resolve) => { setTimeout(resolve, checkInterval); });
  }

  const timeoutReason = `Timeout waiting for tasks to complete after ${timeoutMinutes} minutes`;
  log.error(timeoutReason);
  return {
    success: false,
    failures: await collectTaskFailures(taskIds, timeoutReason),
  };
}

/**
 * Removes old automatic backup files from FluxDrive for a given app.
 * Files that fail removal stay with removedFromFluxdrive=0 and will be retried automatically.
 *
 * @async
 * @param {string} appname - The app name
 * @param {string} owner - The owner of the app
 * @param {Array<number>} excludeTaskIds - Task IDs to exclude from deletion (newly created backups)
 * @returns {Promise<Object>} - Object containing removed count and failed count
 */
async function removeOldAutomaticBackupFiles(appname, owner, excludeTaskIds = []) {
  if (!excludeTaskIds || excludeTaskIds.length === 0) {
    log.warn('No task IDs to exclude. Skipping cleanup to avoid removing all backups.');
    return { removed: 0, failed: 0 };
  }

  try {
    log.info(`Removing automatic backup files older than 2 weeks for app: ${appname}`);

    const excludeIds = excludeTaskIds.join(',');

    // Calculate timestamp for 2 weeks ago in milliseconds
    // The tasks table uses milliseconds for the timestamp field
    const twoWeeksAgoTimestamp = Date.now() - (14 * 24 * 60 * 60 * 1000);

    // Query for old automatic backups that haven't been removed yet and are older than 2 weeks
    // This will include previously failed removals automatically
    const query = `
      SELECT taskId, hash, filename, filesize, timestamp
      FROM tasks
      WHERE appname = ?
      AND owner = ?
      AND backup_type = 'automatic'
      AND uploaded = 1
      AND removedFromFluxdrive = 0
      AND finishTime <> 0
      AND timestamp < ?
      AND taskId NOT IN (${excludeIds})
    `;

    const oldTasks = await dbCli.execute(query, [appname, owner, twoWeeksAgoTimestamp]);

    if (!oldTasks || oldTasks.length === 0) {
      log.info(`No automatic backup files older than 2 weeks to remove for ${appname}`);
      return { removed: 0, failed: 0 };
    }

    log.info(`Found ${oldTasks.length} automatic backup files older than 2 weeks to remove for ${appname}`);

    let removedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < oldTasks.length; i += 1) {
      const task = oldTasks[i];

      if (!task.hash) {
        log.warn(`Task ${task.taskId} has no hash, skipping`);
        // eslint-disable-next-line no-continue
        continue;
      }

      try {
        log.info(`Removing: taskId=${task.taskId}, hash=${task.hash}, filename=${task.filename}`);

        const removeResult = await fluxDrive.removeFile(task.hash);

        if (removeResult === null) {
          throw new Error('FluxDrive removeFile returned null');
        }

        // Successfully removed, mark as soft deleted
        await dbCli.softRemoveTask(task.taskId);

        log.info(`✓ Removed old automatic backup: taskId=${task.taskId}, hash=${task.hash}`);
        removedCount += 1;
      } catch (error) {
        log.error(`✗ Failed to remove taskId=${task.taskId}, hash=${task.hash}:`, error.message);
        failedCount += 1;
        // Task stays with removedFromFluxdrive=0, will be retried next time
      }
    }

    log.info(`Cleanup summary for ${appname}: ${removedCount} removed, ${failedCount} failed (will retry later)`);

    return { removed: removedCount, failed: failedCount };
  } catch (error) {
    log.error(`Error removing old automatic backup files for ${appname}:`, error.message);
    return { removed: 0, failed: 0 };
  }
}

/**
 * Periodically cleans up old automatic backups that failed removal.
 * Simply queries all old automatic backups with removedFromFluxdrive=0 and retries.
 *
 * @async
 * @returns {Promise<Object>} - Summary of cleanup results
 */
async function cleanupOldAutomaticBackups() {
  try {
    log.info('Running periodic cleanup for old automatic backups...');

    // Find all apps with old automatic backups that haven't been removed
    const query = `
      SELECT DISTINCT appname, owner
      FROM tasks
      WHERE backup_type = 'automatic'
      AND uploaded = 1
      AND removedFromFluxdrive = 0
      AND finishTime <> 0
    `;

    const appsWithOldBackups = await dbCli.execute(query);

    if (!appsWithOldBackups || appsWithOldBackups.length === 0) {
      log.info('No old automatic backups to clean up');
      return { totalRemoved: 0, totalFailed: 0, appsProcessed: 0 };
    }

    log.info(`Found ${appsWithOldBackups.length} apps with old automatic backups to clean up`);

    let totalRemoved = 0;
    let totalFailed = 0;

    for (let i = 0; i < appsWithOldBackups.length; i += 1) {
      const { appname, owner } = appsWithOldBackups[i];

      // Get the latest automatic backup tasks for this app directly from tasks table
      // We exclude the latest task for EACH component to ensure we don't delete the current backup
      const latestTaskQuery = `
        SELECT taskId
        FROM tasks t1
        WHERE appname = ?
        AND owner = ?
        AND backup_type = 'automatic'
        AND timestamp = (
          SELECT MAX(timestamp)
          FROM tasks t2
          WHERE t2.appname = t1.appname
          AND t2.owner = t1.owner
          AND t2.component = t1.component
          AND t2.backup_type = 'automatic'
        )
      `;

      const latestTasks = await dbCli.execute(latestTaskQuery, [appname, owner]);

      const excludeTaskIds = latestTasks.map((t) => t.taskId);

      // Only cleanup if we have tasks to exclude (safeguard to ensure we keep at least the latest backup)
      if (excludeTaskIds.length > 0) {
        const result = await removeOldAutomaticBackupFiles(appname, owner, excludeTaskIds);
        totalRemoved += result.removed;
        totalFailed += result.failed;
      }
    }

    log.info(`Global cleanup summary: ${totalRemoved} removed, ${totalFailed} failed, ${appsWithOldBackups.length} apps processed`);

    return { totalRemoved, totalFailed, appsProcessed: appsWithOldBackups.length };
  } catch (error) {
    log.error('Error in cleanupOldAutomaticBackups:', error.message);
    return { totalRemoved: 0, totalFailed: 0, appsProcessed: 0 };
  }
}

/**
 * Removes backup file from remote host
 * Converts the download URL to removal URL and sends request with team authentication
 * @async
 * @param {string} host - The host URL from task (download URL)
 * @param {number} taskId - The task ID for updating database
 * @returns {Promise<boolean>} - true if removal was successful, false otherwise
 */
async function removeBackupFromRemoteHost(host, taskId) {
  try {
    // Convert download URL to removal URL
    // From: http://99.132.138.126:16177/backup/downloadlocalfile/...
    // To:   http://99.132.138.126:16177/backup/removebackupfile/...
    const removalUrl = host.replace('/backup/downloadlocalfile/', '/backup/removebackupfile/');

    log.info(`Attempting to remove remote file for task ${taskId} from: ${removalUrl}`);

    // Get team credentials for authentication
    const teamFluxID = await Vault.getKey('teamFluxID');
    const teamPK = await Vault.getKey('teamPK');

    // Parse URL to get node address
    const urlParts = new URL(removalUrl);
    const nodeUrl = `${urlParts.protocol}//${urlParts.host}`;

    // Get zelidAuth for the request
    const zelidAuth = await fluxOS.verifyLogin(teamFluxID, teamPK, nodeUrl);

    if (!zelidAuth) {
      log.error(`Failed to authenticate with node for task ${taskId}`);
      return false;
    }

    // Make the removal request using axios
    const response = await axios.get(removalUrl, {
      headers: {
        zelidauth: zelidAuth,
      },
      timeout: 30000, // 30 second timeout
    });

    // Check if removal was successful
    if (response.data && response.data.status === 'success') {
      log.info(`Successfully removed remote file for task ${taskId}`);

      // Update the task to mark remoteRemoved as 1
      await dbCli.execute('UPDATE tasks SET remoteRemoved = 1 WHERE taskId = ?', [taskId]);

      return true;
    }

    log.error(`Failed to remove remote file for task ${taskId}. Response:`, response.data);
    return false;
  } catch (error) {
    log.error(`Error removing remote file for task ${taskId}:`, error.message);
    return false;
  }
}

/**
 * Processes automatic backups by fetching the next scheduled backup from the database,
 * creating backup tasks on the node, and registering them for processing.
 *
 * @async
 * @returns {Promise<boolean>} - Returns true if successful, false if failed
 */
async function processAutomaticBackup() {
  const maxRetries = 3;
  let retryCount = 0;
  let automaticBackup = null;
  let lastFailure = null;

  try {
    // Calculate timestamp for 7 days ago
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    // Fetch first item from automatic_backups table with lowest last_backup_timestamp.
    // Only include records where last_backup_timestamp is older than 7 days (failing apps are retried after this window).
    const backups = await dbCli.execute(
      'SELECT * FROM automatic_backups WHERE status != ? AND last_backup_timestamp < ? ORDER BY last_backup_timestamp ASC LIMIT 1',
      ['cancelled', sevenDaysAgo],
    );

    if (backups.length === 0) {
      log.info('No automatic backups to process');
      return false;
    }

    // eslint-disable-next-line prefer-destructuring
    automaticBackup = backups[0];
    const { id, appname, components } = automaticBackup;

    const isExpired = await fluxOS.isAppExpiredInGlobalSpecs(appname);
    if (isExpired === true) {
      log.info(`Automatic backup cancelled for ${appname}: app is expired`);
      await dbCli.execute(
        'UPDATE automatic_backups SET status = ?, last_backup_timestamp = ?, expire_counter = expire_counter + 1 WHERE id = ?',
        ['cancelled', Date.now(), id],
      );
      return false;
    }
    if (isExpired === null) {
      log.warn(`Could not verify expiration status for ${appname}, proceeding with backup`);
    }

    // Handle components - MySQL might return it as already parsed array or as JSON string
    let componentList;

    if (Array.isArray(components)) {
      // Already an array (MySQL JSON column auto-parsed)
      componentList = components;
    } else if (typeof components === 'string') {
      // It's a string, try to parse it
      try {
        componentList = JSON.parse(components);
      } catch (jsonError) {
        // If JSON parsing fails, treat as comma-separated string
        log.info(`Components field is not valid JSON for ${appname}, treating as comma-separated string`);
        componentList = components.split(',').map((comp) => comp.trim()).filter((comp) => comp);
      }
    } else if (typeof components === 'object' && components !== null) {
      // It's an object but not an array, convert to array
      componentList = [components];
    } else {
      // Fallback to empty array
      log.error(`Unexpected components format for ${appname}:`, components);
      componentList = [];
    }

    // Final validation - ensure it's an array
    if (!Array.isArray(componentList)) {
      componentList = [];
    }

    // Set last_backup_timestamp to current time and reset failing status for retry
    const currentTime = Date.now();
    await dbCli.execute(
      'UPDATE automatic_backups SET last_backup_timestamp = ?, status = ? WHERE id = ?',
      [currentTime, 'pending', id],
    );

    if (automaticBackup.status === 'failing') {
      log.info(`Retrying automatic backup for ${appname} after previous failure (7-day window elapsed)`);
    }

    log.info(`Processing automatic backup for app: ${appname}`);

    // Retry loop for node operations
    while (retryCount < maxRetries) {
      try {
        // Get secondary node from HAProxy
        const nodeAddress = await fluxOS.getSecondaryNodeFromHAProxy(appname);
        if (!nodeAddress) {
          throw new Error(`Failed to get secondary node for ${appname}`);
        }

        const node = `http://${nodeAddress}`;
        log.info(`Using node: ${node}`);

        // Get zelidAuth from node
        const zelidAuth = await fluxOS.verifyLogin(
          await Vault.getKey('teamFluxID'),
          await Vault.getKey('teamPK'),
          node,
        );

        if (!zelidAuth) {
          throw new Error('Failed to authenticate with node');
        }

        // Get app owner
        const owner = await fluxOS.getAppOwner(appname);
        if (!owner) {
          throw new Error(`Failed to get app owner for ${appname}`);
        }

        // Create backup task on node
        const backupResult = await fluxOS.createBackupTaskOnNode(node, zelidAuth, appname, componentList);
        if (!backupResult || !backupResult.components) {
          throw new Error('Failed to create backup tasks on node');
        }

        log.info(`Created backup tasks for ${backupResult.totalComponents} components`);

        // Register backup tasks for each component
        const taskIds = [];
        const registrationFailures = [];
        // eslint-disable-next-line no-restricted-syntax
        let backupTimestamp = 0;
        // eslint-disable-next-line no-restricted-syntax
        for (const componentData of backupResult.components) {
          if (componentData.backups && componentData.host) {
            if (backupTimestamp === 0) backupTimestamp = componentData.backups.create;
            const taskObj = {
              appname,
              component: componentData.component,
              timestamp: backupTimestamp,
              host: componentData.host,
              filesize: componentData.backups.size,
              owner,
              filename: componentData.backups.name,
              backup_type: 'automatic',
            };

            try {
              const mockReq = { body: {}, query: {}, headers: {} };
              const { mockRes, getTaskId, getError } = createRegistrationMocks();

              await registerBackupTask(mockReq, mockRes, taskObj);
              const taskId = getTaskId();
              if (taskId) {
                taskIds.push(taskId);
                log.info(`Registered task ${taskId} for component ${componentData.component}`);
              } else {
                const registrationError = getError();
                log.error(`Failed to queue backup for component ${componentData.component}:`, registrationError);
                registrationFailures.push({
                  taskId: null,
                  component: componentData.component,
                  message: registrationError,
                  fails: 0,
                });
              }
            } catch (error) {
              log.error(`Failed to register task for component ${componentData.component}:`, error);
              registrationFailures.push({
                taskId: null,
                component: componentData.component,
                message: getErrorMessage(error),
                fails: 0,
              });
            }
          } else {
            registrationFailures.push({
              taskId: null,
              component: componentData.component,
              message: componentData.error || 'Backup file was not found on the Flux node after creation',
              fails: 0,
            });
          }
        }

        if (taskIds.length === 0) {
          throw createBackupFailure(
            summarizeRegistrationFailures(registrationFailures),
            'create_backup',
            registrationFailures,
          );
        }

        // Wait for all new backup tasks to complete successfully
        log.info(`Waiting for ${taskIds.length} new automatic backup tasks to complete...`);
        const waitResult = await waitForTasksToComplete(taskIds, 60);

        if (waitResult.success) {
          log.info('All new automatic backup tasks completed successfully. Proceeding with cleanup...');

          // Remove backup files from remote hosts
          log.info(`Removing backup files from remote hosts for ${taskIds.length} tasks...`);
          let remoteRemovalCount = 0;
          // Using traditional for loop to avoid ESLint no-restricted-syntax error
          for (let i = 0; i < taskIds.length; i += 1) {
            const taskId = taskIds[i];
            // Get task details to get the host URL
            // eslint-disable-next-line no-await-in-loop
            const taskDetails = await dbCli.execute('SELECT host FROM tasks WHERE taskId = ?', [taskId]);
            if (taskDetails.length > 0 && taskDetails[0].host) {
              // eslint-disable-next-line no-await-in-loop
              const removalSuccess = await removeBackupFromRemoteHost(taskDetails[0].host, taskId);
              if (removalSuccess) {
                remoteRemovalCount += 1;
              }
            }
          }
          log.info(`Remote file removal complete: ${remoteRemovalCount}/${taskIds.length} files removed from nodes`);

          // Remove old automatic backup files (excluding the newly created ones)
          // log.info(`Removing old automatic backup files for ${appname}`);
          const cleanupResult = await removeOldAutomaticBackupFiles(appname, owner, taskIds);
          log.info(`Cleanup complete: ${cleanupResult.removed} old files removed, ${cleanupResult.failed} failed (will retry later)`);

          // Update automatic_backups record with new task IDs and set status to 'done'
          const backupTasksJson = JSON.stringify(taskIds);
          await dbCli.execute(
            'UPDATE automatic_backups SET backup_tasks = ?, status = ? WHERE id = ?',
            [backupTasksJson, 'done', id],
          );

          log.info(`Successfully processed automatic backup for ${appname}. Created ${taskIds.length} tasks.`);
          return true;
        }

        const taskFailureSummary = waitResult.failures
          .map((failure) => `${failure.component}: ${failure.message}`)
          .join('; ');
        log.error('New backup tasks did not complete successfully. Keeping old backups intact.', taskFailureSummary);
        throw createBackupFailure(
          taskFailureSummary || 'New backup tasks failed to complete',
          'task_pipeline',
          waitResult.failures,
        );
      } catch (error) {
        retryCount += 1;
        lastFailure = {
          stage: inferFailureStage(error),
          reason: getErrorMessage(error),
          taskFailures: error.taskFailures || [],
        };
        log.error(`Attempt ${retryCount}/${maxRetries} failed for automatic backup ${appname}:`, lastFailure.reason);

        if (retryCount < maxRetries) {
          log.info('Waiting 20 seconds before retry...');
          await new Promise((resolve) => { setTimeout(resolve, 20000); });
        }
      }
    }

    // If all retries failed, update status to 'failing'
    await dbCli.execute(
      'UPDATE automatic_backups SET status = ? WHERE id = ?',
      ['failing', id],
    );

    log.error(`All retries failed for automatic backup ${appname}. Status set to failing.`, lastFailure?.reason);
    await discordNotifier.notifyAutomaticBackupFailure({
      appname,
      stage: lastFailure?.stage || 'automatic_backup',
      reason: lastFailure?.reason || 'All retries exhausted',
      taskFailures: lastFailure?.taskFailures || [],
      retryCount,
      maxRetries,
    });
    return false;
  } catch (error) {
    log.error('Error in processAutomaticBackup:', error.message);

    // Update status to failing if we have the backup record
    if (automaticBackup) {
      try {
        await dbCli.execute(
          'UPDATE automatic_backups SET status = ? WHERE id = ?',
          ['failing', automaticBackup.id],
        );
      } catch (updateError) {
        log.error('Failed to update status to failing:', updateError.message);
      }

      await discordNotifier.notifyAutomaticBackupFailure({
        appname: automaticBackup.appname,
        stage: inferFailureStage(error),
        reason: getErrorMessage(error),
        taskFailures: error.taskFailures || lastFailure?.taskFailures || [],
        retryCount,
        maxRetries,
      });
    }

    return false;
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
  }, 20 * 1000);
  await dbCli.checkSchema();
  setInterval(async () => {
    await checkExpiredApps();
  }, 60 * 60 * 1000);
  // Sync Syncthing apps periodically
  setInterval(async () => {
    await syncSyncthingApps();
  }, 24 * 60 * 60 * 1000); // Run every 24 hours
  // Run initial sync and cleanup
  await syncSyncthingApps();
  await cleanupOldAutomaticBackups();

  // Process automatic backups every 10 minutes
  setInterval(async () => {
    await processAutomaticBackup();
  }, 15 * 60 * 1000); // Run every 15 minutes

  // Periodic cleanup of old automatic backups (catches failed removals)
  setInterval(async () => {
    await cleanupOldAutomaticBackups();
  }, 24 * 60 * 60 * 1000); // Run every 24 hours
}

module.exports = {
  init,
  registerBackupTask,
  getBackupList,
  getTaskStatus,
  removeCheckpoint,
  syncSyncthingApps,
  processAutomaticBackup,
  waitForTasksToComplete,
  removeOldAutomaticBackupFiles,
  cleanupOldAutomaticBackups,
};
