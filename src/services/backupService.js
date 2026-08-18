/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DBClient = require('./utils/DBClient');
const log = require('../lib/log');
const config = require('../../config/default');
const idService = require('./idService');
const messageHelper = require('./utils/messageHelper');
const fileManager = require('./fileService');
const fluxDrive = require('./fluxDrive');
const fluxOS = require('./fluxOsService');
const marketplaceService = require('./marketplaceService');
const Vault = require('./Vault');
const discordNotifier = require('./discordNotifier');
const {
  extractReconciledTasks,
  isRecoverableTask,
} = require('./utils/reconciliationRecovery');
const {
  groupBackupTasksByAge,
  planBackupPruning,
} = require('./utils/quotaRetention');

let dbCli = null;

const taskQueue = new Map();
const userQuotaOperations = new Map();
const TASK_MAX_FAILURES = 4;
let fluxDriveReconciliationRunning = false;

function getQuotaLimitBytes() {
  return config.quotaPerUser * 1024 * 1024 * 1024;
}

async function getUserStorageUsed(owner) {
  const query = `
    SELECT SUM(filesize) AS totalUsed
    FROM tasks
    WHERE owner = ?
    AND removedFromFluxdrive = 0
    AND (uploaded = 1 OR (uploaded = 0 AND finishTime = 0 AND fails < ?))
  `;
  const params = [owner, TASK_MAX_FAILURES];
  const totalUsed = await dbCli.execute(query, params);
  if (totalUsed.length > 0 && totalUsed[0].totalUsed) {
    return Number(totalUsed[0].totalUsed);
  }
  return 0;
}

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

async function logFluxDriveStoredSize() {
  try {
    const rows = await dbCli.execute(`
      SELECT COUNT(*) AS fileCount, COALESCE(SUM(filesize), 0) AS totalBytes
      FROM tasks
      WHERE uploaded = 1
      AND removedFromFluxdrive = 0
    `);
    const inventory = rows?.[0];
    const totalBytes = Number(inventory?.totalBytes ?? 0);
    const fileCount = Number(inventory?.fileCount ?? 0);

    if (!Number.isFinite(totalBytes) || !Number.isFinite(fileCount)) {
      log.warn('Could not calculate FluxDrive stored backup size from database values');
      return;
    }

    const totalMiB = (totalBytes / (1024 * 1024)).toFixed(2);
    const totalGiB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
    log.info(`FluxDrive active storage at startup: files=${fileCount}, totalSize=${totalBytes} bytes (${totalMiB} MiB, ${totalGiB} GiB)`);
  } catch (error) {
    log.warn(`Could not log FluxDrive stored backup size at startup: ${getErrorMessage(error)}`);
  }
}

function getFluxDriveRemovalError(removeResult) {
  if (!removeResult || removeResult.status === 'error' || removeResult.success === false) {
    return removeResult?.message || 'FluxDrive rejected the file removal';
  }
  return null;
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

async function cancelTaskDueToQuota(task, taskId, filesize) {
  log.warn(`Cancelling task ${taskId}: ${filesize} bytes cannot fit within user quota after automatic-backup pruning`);
  const cancelledTask = {
    ...task,
    status: { state: 'cancelled', message: 'user quota exceeded and insufficient automatic backups can be removed', progress: 0 },
    finishTime: Math.floor(Date.now() / 1000),
    removedFromFluxdrive: 1,
    uploaded: 0,
  };
  // eslint-disable-next-line no-use-before-define
  const remoteRemoved = await removeBackupFromRemoteHost(cancelledTask.host, taskId);
  if (remoteRemoved) cancelledTask.remoteRemoved = 1;
  if (fileManager.fileExists(cancelledTask) || !cancelledTask.localRemoved) {
    try {
      await fileManager.deleteFile(cancelledTask);
      cancelledTask.localRemoved = 1;
    } catch (error) {
      log.error(`Failed to remove local file for quota-cancelled task ${taskId}: ${getErrorMessage(error)}`);
    }
  }
  await dbCli.updateTask(cancelledTask);
  taskQueue.delete(Number(taskId));
}

function runUserQuotaOperation(owner, operation) {
  const previousOperation = userQuotaOperations.get(owner) || Promise.resolve();
  const currentOperation = previousOperation.catch(() => {}).then(operation);
  userQuotaOperations.set(owner, currentOperation);
  return currentOperation.finally(() => {
    if (userQuotaOperations.get(owner) === currentOperation) {
      userQuotaOperations.delete(owner);
    }
  });
}

async function getQuotaPruningCandidates(task) {
  return dbCli.execute(`
    SELECT stored.taskId, stored.appname, stored.timestamp, stored.hash,
      stored.filename, stored.filesize
    FROM tasks stored
    WHERE stored.owner = ?
    AND stored.backup_type = 'automatic'
    AND stored.uploaded = 1
    AND stored.removedFromFluxdrive = 0
    AND stored.finishTime > 0
    AND stored.hash IS NOT NULL
    AND stored.hash <> ''
    AND NOT (stored.appname = ? AND stored.timestamp = ?)
    AND NOT EXISTS (
      SELECT 1
      FROM tasks pending
      WHERE pending.owner = stored.owner
      AND pending.appname = stored.appname
      AND pending.timestamp = stored.timestamp
      AND pending.removedFromFluxdrive = 0
      AND pending.uploaded = 0
      AND pending.finishTime = 0
      AND pending.fails < ?
    )
    ORDER BY stored.timestamp ASC, stored.taskId ASC
  `, [task.owner, task.appname, task.timestamp, TASK_MAX_FAILURES]);
}

async function ensureUserQuotaForDownloadedTask(task) {
  return runUserQuotaOperation(task.owner, async () => {
    const quotaLimit = getQuotaLimitBytes();
    const taskFilesize = Number(task.filesize);
    if (!Number.isFinite(taskFilesize) || taskFilesize < 0 || taskFilesize > quotaLimit) {
      return false;
    }

    let usedBytes = await getUserStorageUsed(task.owner);
    if (usedBytes <= quotaLimit) return true;

    const bytesNeeded = usedBytes - quotaLimit;
    const candidates = await getQuotaPruningCandidates(task);
    const pruningPlan = planBackupPruning(candidates, bytesNeeded);
    const batches = groupBackupTasksByAge(candidates);

    if (!pruningPlan.canReclaim) {
      log.warn(`Quota pruning cannot fit task ${task.taskId}: need=${bytesNeeded} bytes, reclaimable=${pruningPlan.reclaimableBytes} bytes`);
      return false;
    }

    log.info(`Quota pruning for task ${task.taskId}: used=${usedBytes}, limit=${quotaLimit}, need=${bytesNeeded}, candidateBatches=${batches.length}`);
    for (let batchIndex = 0; batchIndex < batches.length && usedBytes > quotaLimit; batchIndex += 1) {
      const batch = batches[batchIndex];
      log.info(`Removing oldest automatic backup batch: app=${batch.appname}, timestamp=${batch.timestamp}, files=${batch.tasks.length}, size=${batch.totalBytes}`);

      for (let taskIndex = 0; taskIndex < batch.tasks.length; taskIndex += 1) {
        const oldTask = batch.tasks[taskIndex];
        const removeResult = await fluxDrive.removeFileVerified(oldTask.hash);
        const removalError = getFluxDriveRemovalError(removeResult);
        if (removalError) {
          log.error(`Quota pruning failed for task ${oldTask.taskId}: ${removalError}`);
        } else {
          const updateResult = await dbCli.softRemoveTask(oldTask.taskId);
          if (updateResult?.affectedRows === 1) {
            log.info(`Quota pruning removed task ${oldTask.taskId} (${oldTask.filesize} bytes)`);
          } else {
            log.error(`Quota pruning could not update removed task ${oldTask.taskId}`);
          }
        }
      }

      usedBytes = await getUserStorageUsed(task.owner);
    }

    if (usedBytes > quotaLimit) {
      log.warn(`Quota pruning did not free enough space for task ${task.taskId}: used=${usedBytes}, limit=${quotaLimit}`);
      return false;
    }

    log.info(`Quota pruning completed for task ${task.taskId}: used=${usedBytes}, limit=${quotaLimit}`);
    return true;
  });
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
    if (!task.downloaded || task.localRemoved || !fileManager.fileExists(task)) {
      // download the file
      log.info(`downloading task ${id}.`);
      task.status = { state: 'downloading', message: 'fetching file from node', progress: 0 };
      await dbCli.updateTask(task);
      await fileManager.downloadFileFromHost(task);
      // task.status = { state: 'downloading', message: 'fetching file from node', progress: 100 };
      await dbCli.updateTask(task);
    }
    if (!task.uploaded && !await ensureUserQuotaForDownloadedTask(task)) {
      await cancelTaskDueToQuota(task, id, task.filesize);
      return;
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
    if (fileManager.fileExists(task) || !task.localRemoved) {
      // remove the file locally
      log.info(`removing local file for task ${id}.`);
      await fileManager.deleteFile(task);
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
    taskQueue.delete(id);
    log.error(`task ${id} failed:`, error instanceof Error ? error : message);
  }
}

/**
 * This function updates the task queue. It first removes any tasks from the queue that have been running for more than an hour.
 * Then, if the queue has space, it fetches the latest remaining tasks from the database and adds them to the queue.
 * It only fetches tasks that have not finished and have attempts remaining.
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
    const records = await dbCli.execute(`select * from tasks where finishTime=0 and fails<${TASK_MAX_FAILURES} order by timestamp limit ${Number(emptySlots)}`);
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
            const removeResult = await fluxDrive.removeFileVerified(record.hash);
            const removalError = getFluxDriveRemovalError(removeResult);
            if (removalError) {
              log.error(`Failed to remove expired-app task ${record.taskId}: ${removalError}`);
            } else {
              await dbCli.softRemoveTask(record.taskId);
            }
          }
        }
        if (appSpecs && appSpecs === 'Application not found') {
          log.info(`id: ${record.taskId}, appname: ${record.appname}, hash: ${record.hash} removed from FluxDrive.`);
          const removeResult = await fluxDrive.removeFileVerified(record.hash);
          const removalError = getFluxDriveRemovalError(removeResult);
          if (removalError) {
            log.error(`Failed to remove expired-app task ${record.taskId}: ${removalError}`);
          } else {
            await dbCli.softRemoveTask(record.taskId);
          }
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

    const marketplaceTemplates = await marketplaceService.getMarketplaceTemplates();
    const marketplaceClassificationAvailable = Array.isArray(marketplaceTemplates)
      && marketplaceTemplates.length > 0;
    if (!marketplaceClassificationAvailable) {
      log.warn('Marketplace classification unavailable; unchecked apps will be retried during the next sync');
    }

    // Get all apps currently in automatic_backups table
    const existingApps = await dbCli.execute('SELECT appname, expire_counter, is_marketplace FROM automatic_backups');
    const existingAppsByName = new Map(existingApps.map((app) => [app.appname, app]));

    // Check for new apps to add
    const newAppsToAdd = [];
    syncthingApps.forEach((app) => {
      if (!existingAppsByName.has(app.appName)) {
        newAppsToAdd.push(app);
      }
    });

    // Add new apps to the table
    for (let i = 0; i < newAppsToAdd.length; i += 1) {
      const app = newAppsToAdd[i];
      const componentsJson = JSON.stringify(app.componentNames);
      const isMarketplace = marketplaceClassificationAvailable
        ? Number(marketplaceService.matchesMarketplaceRepotags(app.repotags, marketplaceTemplates))
        : null;
      const query = `INSERT INTO automatic_backups (
        appname, components, status, expire_counter, last_backup_timestamp, is_marketplace
      ) VALUES (?, ?, 'pending', 0, 0, ?)`;
      await dbCli.execute(query, [app.appName, componentsJson, isMarketplace]);
      log.info(`Added new app ${app.appName} to automatic_backups (marketplace=${isMarketplace === null ? 'unchecked' : Boolean(isMarketplace)})`);
    }

    let classifiedExistingApps = 0;
    if (marketplaceClassificationAvailable) {
      for (let i = 0; i < syncthingApps.length; i += 1) {
        const app = syncthingApps[i];
        const existingApp = existingAppsByName.get(app.appName);
        if (existingApp && existingApp.is_marketplace === null) {
          const isMarketplace = Number(
            marketplaceService.matchesMarketplaceRepotags(app.repotags, marketplaceTemplates),
          );
          await dbCli.execute(
            'UPDATE automatic_backups SET is_marketplace = ? WHERE appname = ? AND is_marketplace IS NULL',
            [isMarketplace, app.appName],
          );
          classifiedExistingApps += 1;
          log.info(`Classified existing app ${app.appName} as marketplace=${Boolean(isMarketplace)}`);
        }
      }
    }

    // Check for expired apps (in DB but not in current syncthing list)
    const currentAppNames = new Set(syncthingApps.map((app) => app.appName));
    const expiredApps = [];
    existingAppsByName.forEach((existingApp, appName) => {
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

    log.info(`Sync complete. Added ${newAppsToAdd.length} new apps, classified ${classifiedExistingApps} existing apps, marked ${expiredApps.length} as expired.`);
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
 * It rejects files that can never fit within the user quota and checks for duplicates.
 * Existing automatic backups are pruned only after the new file has downloaded successfully.
 * If all checks pass, it adds the task to the database and runs the task if there is space in the queue.
 * If any step fails, it logs the error and sends an error message as the response.
 *
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @param {Object} taskObj - Optional task object containing all required variables (appname, component, timestamp, host, filesize, owner, filename, backup_type)
 * @throws Will throw an error if the user session is invalid, parameters are invalid, a file is larger than the user quota, the task is a duplicate, or database operation fails.
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
    if (Number(filesize) > getQuotaLimitBytes()) {
      throw new Error('backup file is larger than the user quota.');
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
    // check if task is a duplicate (needed before quota check to avoid double-counting)
    const record = await dbCli.execute(`
      SELECT *
      FROM tasks
      WHERE owner = ?
      AND timestamp = ?
      AND appname = ?
      AND component = ?
      AND removedFromFluxdrive = 0
      AND (uploaded = 1 OR (uploaded = 0 AND finishTime = 0 AND fails < ?))
      ORDER BY taskId DESC
      LIMIT 1
    `, [owner, timestamp, appname, component, TASK_MAX_FAILURES]);
    if (record.length > 0 && record[0].uploaded === 1) {
      throw new Error('Checkpoint has already been uploaded to FluxDrive.');
    }
    let taskId = null;
    if (record.length > 0 && record[0].uploaded === 0) {
      // Resume existing task; return its ID even if the queue is full (updateQueue will retry)
      taskId = record[0].taskId;
      if (taskQueue.size < config.maxConcurrentTasks) {
        const task = await dbCli.getTask(taskId);
        if (task) {
          task.extra = taskObj ? '' : req.headers.zelidauth;
          task.removedFromFluxdrive = 0;
          await dbCli.updateTask(task);
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
  const requestStartedAt = Date.now();
  const suppliedRequestId = String(req.headers['x-request-id'] || '');
  const requestId = /^[A-Za-z0-9._-]{1,80}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : `backup-list-${requestStartedAt}-${Math.random().toString(36).slice(2, 10)}`;
  let stage = 'session_validation';
  res.setHeader('X-Request-ID', requestId);
  log.info(`[getbackuplist:${requestId}] request started: app=${appname || 'missing'}`);

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
    stage = 'owner_resolution';

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

    stage = 'database_query';
    const queryStartedAt = Date.now();
    log.info(`[getbackuplist:${requestId}] database query started: app=${appname}`);
    const result = await dbCli.getUserBackups(backupOwner, appname);
    const queryDurationMs = Date.now() - queryStartedAt;
    const resultCount = Array.isArray(result) ? result.length : 0;
    log.info(`[getbackuplist:${requestId}] database query completed: app=${appname}, rows=${resultCount}, durationMs=${queryDurationMs}`);
    stage = 'response_build';
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
    stage = 'response_send';
    res.json({ status: 'success', checkpoints });
    log.info(`[getbackuplist:${requestId}] response sent: app=${appname}, checkpoints=${checkpoints.length}, durationMs=${Date.now() - requestStartedAt}`);
  } catch (error) {
    log.error(`[getbackuplist:${requestId}] request failed: app=${appname || 'missing'}, stage=${stage}, durationMs=${Date.now() - requestStartedAt}, code=${error.code || 'unknown'}, message=${error.message}`);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    if (!res.headersSent) {
      res.json(errMessage);
    }
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
          const removeResult = await fluxDrive.removeFileVerified(checkpoint[i].hash);
          const removalError = getFluxDriveRemovalError(removeResult);
          if (removalError) {
            log.error(`Failed to remove checkpoint task ${checkpoint[i].taskId}: ${removalError}`);
            // eslint-disable-next-line no-continue
            continue;
          }
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
    let allSettled = true;
    let failureReason = null;
    let failedTaskId = null;

    for (let i = 0; i < taskIds.length; i += 1) {
      const taskId = taskIds[i];
      const task = await dbCli.getTask(taskId);

      if (!task) {
        failureReason = failureReason || 'Task not found in database';
        failedTaskId = failedTaskId || taskId;
        // eslint-disable-next-line no-continue
        continue;
      }

      if (task.fails >= TASK_MAX_FAILURES) {
        failureReason = failureReason || `Task failed ${task.fails} times`;
        failedTaskId = failedTaskId || taskId;
        log.error(`Task ${taskId} failed ${task.fails} times: ${task.status?.message || failureReason}`);
        // eslint-disable-next-line no-continue
        continue;
      }

      if (task.finishTime === 0) {
        allCompleted = false;
        allSettled = false;
        // eslint-disable-next-line no-continue
        continue;
      }

      if (task.uploaded !== 1) {
        failureReason = failureReason || task.status?.message || 'Task did not upload successfully';
        failedTaskId = failedTaskId || taskId;
        log.error(`Task ${taskId} did not upload successfully: ${failureReason}`);
      }
    }

    if (failureReason && allSettled) {
      log.error('Some tasks failed after all component tasks settled.');
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
 * Removes artifacts created by a new automatic-backup batch that did not complete.
 * Only terminal tasks are touched so an in-flight upload cannot race with cleanup.
 *
 * @param {Array<number>} taskIds - Task IDs belonging to the incomplete batch
 * @returns {Promise<Object>} - Cleanup counts
 */
async function cleanupIncompleteAutomaticBackupTasks(taskIds) {
  let removed = 0;
  let failed = 0;
  let inProgress = 0;

  for (let i = 0; i < taskIds.length; i += 1) {
    const taskId = taskIds[i];
    const task = await dbCli.getTask(taskId);

    if (!task) {
      failed += 1;
      // eslint-disable-next-line no-continue
      continue;
    }

    const isTerminal = task.finishTime > 0 || task.fails >= TASK_MAX_FAILURES;
    if (!isTerminal) {
      inProgress += 1;
      // eslint-disable-next-line no-continue
      continue;
    }

    await dbCli.execute(
      'UPDATE tasks SET backup_type = ? WHERE taskId = ?',
      ['automatic_failed', taskId],
    );

    let artifactCleanupFailed = false;

    if (task.host && !task.remoteRemoved) {
      // eslint-disable-next-line no-use-before-define
      const remoteRemoved = await removeBackupFromRemoteHost(task.host, taskId);
      if (!remoteRemoved) {
        artifactCleanupFailed = true;
        failed += 1;
      }
    }

    if (task.fails >= TASK_MAX_FAILURES && !task.localRemoved) {
      try {
        await fileManager.deleteFile(task);
        await dbCli.execute('UPDATE tasks SET localRemoved = 1 WHERE taskId = ?', [taskId]);
      } catch (error) {
        log.error(`Failed to remove local file for incomplete task ${taskId}:`, error.message);
        artifactCleanupFailed = true;
        failed += 1;
      }
    }

    if (task.uploaded === 1) {
      if (!task.hash) {
        log.warn(`Incomplete automatic backup task ${taskId} has no FluxDrive hash`);
        failed += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      const removeResult = await fluxDrive.removeFileVerified(task.hash);
      const removalError = getFluxDriveRemovalError(removeResult);
      if (removalError) {
        log.error(`Failed to roll back incomplete automatic backup task ${taskId}: ${removalError}`);
        failed += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      await dbCli.softRemoveTask(taskId);
      removed += 1;
    } else if (!artifactCleanupFailed) {
      await dbCli.softRemoveTask(taskId);
      removed += 1;
    }
  }

  return { removed, failed, inProgress };
}

/**
 * Periodically cleans up terminal automatic tasks.
 * Includes legacy failed tasks that were never reclassified as automatic_failed.
 * Successful backup retention is quota-driven during the upload path.
 *
 * @async
 * @returns {Promise<Object>} - Summary of cleanup results
 */
async function cleanupOldAutomaticBackups() {
  try {
    log.info('Running periodic cleanup for incomplete automatic backups...');

    const incompleteTasks = await dbCli.execute(`
      SELECT taskId
      FROM tasks
      WHERE (
        backup_type = 'automatic_failed'
        OR (
          backup_type = 'automatic'
          AND uploaded = 0
          AND (finishTime > 0 OR fails >= ?)
        )
      )
      AND (
        removedFromFluxdrive = 0
        OR remoteRemoved = 0
        OR (fails >= ? AND localRemoved = 0)
      )
    `, [TASK_MAX_FAILURES, TASK_MAX_FAILURES]);
    const incompleteResult = await cleanupIncompleteAutomaticBackupTasks(
      incompleteTasks.map((task) => task.taskId),
    );

    log.info(`Incomplete automatic backup cleanup summary: ${incompleteResult.removed} removed, ${incompleteResult.failed} failed, ${incompleteResult.inProgress} still in progress`);
    return {
      totalRemoved: incompleteResult.removed,
      totalFailed: incompleteResult.failed,
      appsProcessed: 0,
    };
  } catch (error) {
    log.error('Error in cleanupOldAutomaticBackups:', error.message);
    return { totalRemoved: 0, totalFailed: 0, appsProcessed: 0 };
  }
}

function findTasksChangedByLegacyReconciliation() {
  const reconciledTasks = new Map();
  const logsDirectory = path.join(__dirname, '../../logs');
  const filenames = ['debug.log', 'info.log', 'error.log'];

  for (let i = 0; i < filenames.length; i += 1) {
    const logPath = path.join(logsDirectory, filenames[i]);
    if (fs.existsSync(logPath)) {
      const extracted = extractReconciledTasks(fs.readFileSync(logPath, 'utf8'));
      extracted.forEach((hash, taskId) => reconciledTasks.set(taskId, hash));
    }
  }

  return reconciledTasks;
}

async function isHashRetrievable(hash) {
  const gateway = config.ipfsGatewayUrl.replace(/\/+$/, '');
  try {
    const response = await axios.get(`${gateway}/${encodeURIComponent(hash)}`, {
      headers: { Range: 'bytes=0-0' },
      responseType: 'stream',
      timeout: 30000,
      validateStatus: () => true,
    });
    if (response.data && typeof response.data.destroy === 'function') {
      response.data.destroy();
    }
    return response.status === 200 || response.status === 206;
  } catch (error) {
    log.warn(`Could not directly verify reconciled hash ${hash}: ${getErrorMessage(error)}`);
    return false;
  }
}

/**
 * Repairs records changed by the retired inventory reconciliation.
 *
 * The FluxDrive /ls endpoint is capped and is never used as proof of absence.
 * Only task IDs recorded by the old reconciler are considered, their exact hash
 * must be directly retrievable, and each row can be recovered only once.
 *
 * @async
 * @returns {Promise<Object>} - Recovery summary
 */
async function reconcileFluxDriveInventory() {
  if (fluxDriveReconciliationRunning) {
    log.warn('FluxDrive reconciliation recovery is already running');
    return {
      candidates: 0, recovered: 0, unavailable: 0, skipped: true,
    };
  }

  fluxDriveReconciliationRunning = true;
  try {
    const loggedTasks = findTasksChangedByLegacyReconciliation();
    if (loggedTasks.size === 0) {
      log.info('No records from the retired FluxDrive inventory reconciliation require recovery');
      return {
        candidates: 0, recovered: 0, unavailable: 0, skipped: false,
      };
    }

    const loggedTaskIds = [...loggedTasks.keys()];
    const candidates = [];
    for (let offset = 0; offset < loggedTaskIds.length; offset += 100) {
      const taskIds = loggedTaskIds.slice(offset, offset + 100);
      const placeholders = taskIds.map(() => '?').join(',');
      const rows = await dbCli.execute(`
        SELECT taskId, hash, appname, component, status, uploaded,
          removedFromFluxdrive, reconciliationRecovered
        FROM tasks
        WHERE taskId IN (${placeholders})
        AND uploaded = 0
        AND removedFromFluxdrive = 1
        AND reconciliationRecovered = 0
      `, taskIds);
      if (!Array.isArray(rows)) {
        throw new Error('Could not load tasks changed by the retired reconciliation');
      }
      for (let i = 0; i < rows.length; i += 1) candidates.push(rows[i]);
    }

    let recovered = 0;
    let unavailable = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const task = candidates[i];
      const expectedHash = loggedTasks.get(Number(task.taskId));
      if (isRecoverableTask(task, expectedHash)) {
        if (!await isHashRetrievable(task.hash)) {
          unavailable += 1;
          log.warn(`Legacy reconciliation recovery deferred for task ${task.taskId}: hash ${task.hash} is not directly retrievable`);
        } else {
          const updateResult = await dbCli.execute(`
            UPDATE tasks
            SET uploaded = 1,
              removedFromFluxdrive = 0,
              reconciliationRecovered = 1
            WHERE taskId = ?
            AND hash = ?
            AND uploaded = 0
            AND removedFromFluxdrive = 1
            AND reconciliationRecovered = 0
          `, [task.taskId, task.hash]);
          if (updateResult?.affectedRows !== 1) {
            throw new Error(`Could not recover wrongly reconciled task ${task.taskId}`);
          }
          recovered += 1;
          log.info(`Recovered task ${task.taskId}: directly verified hash ${task.hash} and restored FluxDrive visibility`);
        }
      }
    }

    log.info(`FluxDrive reconciliation recovery summary: candidates=${candidates.length}, recovered=${recovered}, unavailable=${unavailable}`);
    return {
      candidates: candidates.length,
      recovered,
      unavailable,
      skipped: false,
    };
  } catch (error) {
    log.error(`FluxDrive reconciliation recovery failed: ${getErrorMessage(error)}`);
    return {
      candidates: 0, recovered: 0, unavailable: 0, skipped: true,
    };
  } finally {
    fluxDriveReconciliationRunning = false;
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
    const now = Date.now();
    const standardIntervalMs = config.automaticBackupSchedule.standardIntervalHours
      * 60 * 60 * 1000;
    const marketplaceIntervalMs = config.automaticBackupSchedule.marketplaceIntervalHours
      * 60 * 60 * 1000;
    const standardCutoff = now - standardIntervalMs;
    const marketplaceCutoff = now - marketplaceIntervalMs;

    // Marketplace apps and standard apps use independent config-driven schedules.
    // Unchecked apps use the standard interval until classification succeeds.
    const backups = await dbCli.execute(
      `SELECT *
       FROM automatic_backups
       WHERE status != ?
       AND (
         (is_marketplace = 1 AND last_backup_timestamp < ?)
         OR ((is_marketplace = 0 OR is_marketplace IS NULL) AND last_backup_timestamp < ?)
       )
       ORDER BY CASE
         WHEN is_marketplace = 1 THEN last_backup_timestamp + ?
         ELSE last_backup_timestamp + ?
       END ASC
       LIMIT 1`,
      [
        'cancelled',
        marketplaceCutoff,
        standardCutoff,
        marketplaceIntervalMs,
        standardIntervalMs,
      ],
    );

    if (backups.length === 0) {
      log.info('No automatic backups to process');
      return false;
    }

    // eslint-disable-next-line prefer-destructuring
    automaticBackup = backups[0];
    const {
      id, appname, components, is_marketplace: isMarketplace,
    } = automaticBackup;
    const scheduleHours = Number(isMarketplace) === 1
      ? config.automaticBackupSchedule.marketplaceIntervalHours
      : config.automaticBackupSchedule.standardIntervalHours;

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
      log.info(`Retrying automatic backup for ${appname} after previous failure (${scheduleHours}-hour window elapsed)`);
    }

    log.info(`Processing automatic backup for app: ${appname} (marketplace=${Number(isMarketplace) === 1}, intervalHours=${scheduleHours})`);

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

        if (registrationFailures.length > 0) {
          await waitForTasksToComplete(taskIds, 60);
          const rollbackResult = await cleanupIncompleteAutomaticBackupTasks(taskIds);
          log.info(`Incomplete batch rollback: ${rollbackResult.removed} task artifacts removed, ${rollbackResult.failed} cleanup failures`);
          throw createBackupFailure(
            summarizeRegistrationFailures(registrationFailures),
            'task_pipeline',
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
        const rollbackResult = await cleanupIncompleteAutomaticBackupTasks(taskIds);
        log.error(
          `New backup batch failed. Rolled back ${rollbackResult.removed} component artifacts; ${rollbackResult.failed} cleanup operations failed.`,
          taskFailureSummary,
        );
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
        if (lastFailure.stage === 'task_pipeline') {
          log.error(`Automatic backup ${appname} failed after component-level retries:`, lastFailure.reason);
          break;
        }

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
  await logFluxDriveStoredSize();
  setTimeout(async () => {
    await reconcileFluxDriveInventory();
  }, 30 * 1000);
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

  // Start the next due automatic backup at the configured dispatcher interval.
  setInterval(async () => {
    await processAutomaticBackup();
  }, config.automaticBackupSchedule.dispatcherIntervalMinutes * 60 * 1000);

  // Periodic cleanup of incomplete automatic-backup artifacts
  setInterval(async () => {
    await cleanupOldAutomaticBackups();
    await reconcileFluxDriveInventory();
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
  cleanupOldAutomaticBackups,
  reconcileFluxDriveInventory,
};
