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
const Vault = require('./Vault');

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
    const records = await dbCli.execute(`select * from tasks where finishTime=0 and fails<3 order by timestamp limit ${Number(emptySlots)}`);
    if (records.length) log.debug(`${records.length} failed tasks, retrying...`);
    for (let i = 0; i < records.length; i += 1) {
      if (!taskQueue.has(records[i].taskId)) {
        // add task to the queue
        taskQueue.set(Number(records[i].taskId), records[i]);
        // run task
        log.debug(`retrying task ${records[i].taskId}`);
        runTask(Number(records[i].taskId));
      } else {
        log.warn(`task ${records[i].taskId} already in queue.`);
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
      // resume the task if there is space in queue
      if (taskQueue.size < config.maxConcurrentTasks) {
        taskId = record[0].taskId;
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

/**
 * Waits for all backup tasks to complete successfully.
 *
 * @async
 * @param {Array<number>} taskIds - Array of task IDs to monitor
 * @param {number} timeoutMinutes - Timeout in minutes (default: 60)
 * @returns {Promise<boolean>} - True if all tasks completed successfully, false otherwise
 */
async function waitForTasksToComplete(taskIds, timeoutMinutes = 60) {
  if (!taskIds || taskIds.length === 0) {
    log.info('No tasks to wait for');
    return true;
  }

  const startTime = Date.now();
  const timeout = timeoutMinutes * 60 * 1000;
  const checkInterval = 10000; // Check every 10 seconds

  log.info(`Waiting for ${taskIds.length} tasks to complete: ${taskIds.join(', ')}`);

  while (Date.now() - startTime < timeout) {
    let allCompleted = true;
    let anyFailed = false;

    for (let i = 0; i < taskIds.length; i += 1) {
      const taskId = taskIds[i];
      const task = await dbCli.getTask(taskId);

      if (!task) {
        log.error(`Task ${taskId} not found`);
        anyFailed = true;
        break;
      }

      // Check if task failed too many times
      if (task.fails >= 3) {
        log.error(`Task ${taskId} failed ${task.fails} times`);
        anyFailed = true;
        break;
      }

      // Check if task is still in progress
      if (task.finishTime === 0) {
        allCompleted = false;
        break;
      }

      // Check if task uploaded successfully
      if (task.uploaded !== 1) {
        log.error(`Task ${taskId} did not upload successfully`);
        anyFailed = true;
        break;
      }
    }

    if (anyFailed) {
      log.error('Some tasks failed. Aborting cleanup.');
      return false;
    }

    if (allCompleted) {
      log.info('All tasks completed successfully');
      return true;
    }

    // Wait before checking again
    log.debug(`Still waiting for tasks to complete... (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`);
    await new Promise((resolve) => { setTimeout(resolve, checkInterval); });
  }

  log.error(`Timeout waiting for tasks to complete after ${timeoutMinutes} minutes`);
  return false;
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
    log.info(`Removing old automatic backup files for app: ${appname}`);

    const excludeIds = excludeTaskIds.join(',');

    // Query for old automatic backups that haven't been removed yet
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
      AND taskId NOT IN (${excludeIds})
    `;

    const oldTasks = await dbCli.execute(query, [appname, owner]);

    if (!oldTasks || oldTasks.length === 0) {
      log.info(`No old automatic backup files to remove for ${appname}`);
      return { removed: 0, failed: 0 };
    }

    log.info(`Found ${oldTasks.length} old automatic backup files to remove for ${appname}`);

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

      // Get the latest automatic backup tasks for this app (to exclude from deletion)
      const latestBackupQuery = `
        SELECT backup_tasks
        FROM automatic_backups
        WHERE appname = ?
      `;

      const latestBackup = await dbCli.execute(latestBackupQuery, [appname]);

      let excludeTaskIds = [];
      if (latestBackup && latestBackup.length > 0 && latestBackup[0].backup_tasks) {
        try {
          excludeTaskIds = JSON.parse(latestBackup[0].backup_tasks);
        } catch (e) {
          log.warn(`Failed to parse backup_tasks for ${appname}`);
        }
      }

      // Only cleanup if we have tasks to exclude (current backups)
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

  try {
    // Calculate timestamp for 7 days ago
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    // Fetch first item from automatic_backups table with lowest last_backup_timestamp and status not 'failing'
    // Only include records where last_backup_timestamp is older than 7 days
    const backups = await dbCli.execute(
      'SELECT * FROM automatic_backups WHERE status != ? AND last_backup_timestamp < ? ORDER BY last_backup_timestamp ASC LIMIT 1',
      ['failing', sevenDaysAgo],
    );

    if (backups.length === 0) {
      log.info('No automatic backups to process');
      return false;
    }

    // eslint-disable-next-line prefer-destructuring
    automaticBackup = backups[0];
    const { id, appname, components } = automaticBackup;

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

    // Set last_backup_timestamp to current time
    const currentTime = Date.now();
    await dbCli.execute(
      'UPDATE automatic_backups SET last_backup_timestamp = ? WHERE id = ?',
      [currentTime, id],
    );

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
              // Mock req and res objects for registerBackupTask
              const mockReq = { body: {}, query: {}, headers: {} };
              let taskId = null;
              const mockRes = {
                json: (data) => {
                  if (data.status === 'success' && data.data && data.data.taskId) {
                    taskId = data.data.taskId;
                  }
                },
              };

              await registerBackupTask(mockReq, mockRes, taskObj);
              if (taskId) {
                taskIds.push(taskId);
                log.info(`Registered task ${taskId} for component ${componentData.component}`);
              }
            } catch (error) {
              log.error(`Failed to register task for component ${componentData.component}:`, error.message);
            }
          }
        }

        // Wait for all new backup tasks to complete successfully
        log.info(`Waiting for ${taskIds.length} new automatic backup tasks to complete...`);
        const tasksCompleted = await waitForTasksToComplete(taskIds, 15);

        if (tasksCompleted) {
          log.info('All new automatic backup tasks completed successfully. Proceeding with cleanup...');

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
        log.error('New backup tasks did not complete successfully. Keeping old backups intact.');
        throw new Error('New backup tasks failed to complete');
      } catch (error) {
        retryCount += 1;
        log.error(`Attempt ${retryCount}/${maxRetries} failed for automatic backup ${appname}:`, error.message);

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

    log.error(`All retries failed for automatic backup ${appname}. Status set to failing.`);
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
  // Run initial sync
  await syncSyncthingApps();

  // Process automatic backups every 7 minutes
  setInterval(async () => {
    await processAutomaticBackup();
  }, 7 * 60 * 1000); // Run every 7 minutes

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
