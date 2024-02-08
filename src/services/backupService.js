/* eslint-disable no-undef */
const DBClient = require('./utils/DBClient');
const log = require('../lib/log');
const config = require('../../config/default');
const idService = require('./idService');
const messageHelper = require('./utils/messageHelper');
const fileManager = require('./fileService');
const fluxDrive = require('./fluxDrive');

let dbCli = null;

const taskQueue = new Map();

async function runTask(id) {
  console.log(`ruuning task ${id}`);
  const task = taskQueue.get(id);
  try {
    task.startTime = Math.floor(Date.now() / 1000);
    task.status = { state: 'started', message: 'backup to FluxDrive started', progress: 0 };
    await dbCli.updateTask(task);
    // check if file is downloaded
    if (!task.downloaded) {
      // download the file
      console.log(`downloading task ${id}.`);
      await fileManager.downloadFileFromHost(task);
      await dbCli.updateTask(task);
    }
    // check if file is uploaded
    if (!task.uploaded) {
      // upload the file
      console.log(`uploading task ${id}.`);
      await fluxDrive.uploadFile(task);
      await dbCli.updateTask(task);
    }
    // check if the file is removed locally
    if (fileManager.fileExists(task.filename) || !task.localRemoved) {
      // remove the file locally
      console.log(`removing local file for task ${id}.`);
      await fileManager.deleteFile(task.filename);
      task.localRemoved = true;
      await dbCli.updateTask(task);
    }
    // ask remote server to remove the file

    // mark the task as done and remove from queue
    console.log(`task ${id} finished.`);
    task.status = { state: 'finished', message: 'finished', progress: 100 };
    task.finishTime = Math.floor(Date.now() / 1000);
    await dbCli.updateTask(task);
    taskQueue.delete(id);
  } catch (error) {
    task.fails += 1;
    await dbCli.updateTask(task);
    console.log(`task ${id} failed.`);
  }
}

async function updateQueue() {
  // remove failed tasks from queue
  const now = Math.floor(Date.now() / 1000);
  const failTime = 60 * 60; // 1 hour
  taskQueue.forEach((value, key) => {
    if (now - value.startTime > failTime) {
      taskQueue.delete(key);
    }
  });
  // check if queue has space
  if (taskQueue.size < config.maxConcurrentTasks) {
    // read latest remaining tasks from db
    const emptySlots = config.maxConcurrentTasks - taskQueue.size;
    const records = await dbCli.execute(`select * from tasks where finishTime=0 and fails<3 order by timestamp limit ${Number(emptySlots)}`);
    console.log(records);
    for (let i = 0; i < records.length; i += 1) {
      if (!taskQueue.has(records[i].taskId)) {
        // add task to the queue
        taskQueue.set(records[i].taskId, records[i]);
        // run task
        runTask(records[i].taskId);
      }
    }
  }
}

async function init() {
  log.info('Initiating Database...');
  dbCli = await DBClient.createClient();
  await dbCli.checkSchema();
  setInterval(async () => {
    await updateQueue();
  }, 10 * 1000);
}

function isValidUrl(string) {
  try {
    // eslint-disable-next-line no-new
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

async function registerBackupTask(req, res) {
  let { appname } = req.params;
  appname = appname || req.query.appname;
  let { component } = req.params;
  component = component || req.query.component;
  let { filename } = req.params;
  filename = filename || req.query.filename;
  let { timestamp } = req.params;
  timestamp = timestamp || req.query.timestamp;
  let { host } = req.params;
  host = host || req.query.host;
  let { filesize } = req.params;
  filesize = filesize || req.query.filesize;
  console.log(req.body);
  console.log(req.params);
  try {
    // validate session
    const owner = await idService.verifyUserSession(req.headers);
    if (owner === false) {
      throw new Error('Unauthorized. Access denied.');
    }
    // validate app and component name
    if (!appname || !component) {
      throw new Error('Invalid app or component name.');
    }
    // validate timestamp
    const numberpRegex = /^\d+$/;
    if (!numberpRegex.test(timestamp)) {
      throw new Error('timestamp is not valid');
    }
    // validate filename
    if (filename.length < 3) {
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
    // check if user has enough storage quota
    const totalUsed = await dbCli.execute('select sum(filesize) as totalUsed from tasks where owner=? and removedFromFluxdrive=0', [owner]);
    console.log(totalUsed);
    let userTotalUse = 0;
    if (totalUsed.length > 0) userTotalUse = totalUsed[0].totalUsed;
    if (userTotalUse > config.quotaPerUser * 1024 * 1024 * 1024) {
      throw new Error('user quota is full.');
    }
    // check if task is a duplicate
    const record = await dbCli.execute('select taskId from tasks where owner=? and timestamp=? and appname=? and component=?', [owner, timestamp, appname, component]);
    console.log(record);
    if (record.length > 0) {
      throw new Error('duplicate timestamp for same appname and component.');
    }
    // add task to the db
    const newTask = {
      owner, timestamp, filename, appname, component, filesize, host,
    };
    const result = await dbCli.addNewTask(newTask);
    const taskId = result.insertId;
    console.log(result);
    // run the task if there is space in queue
    if (taskQueue.size < config.maxConcurrentTasks) {
      const task = await dbCli.getTask(taskId);
      if (task) {
        taskQueue.set(taskId, task);
        runTask(taskId);
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

async function getBackupList(req, res) {
  let { appname } = req.params;
  appname = appname || req.query.appname;

  try {
    // validate session
    const owner = await idService.verifyUserSession(req.headers);
    if (owner === false) {
      throw new Error('Unauthorized. Access denied.');
    }
    // validate app and component name
    if (!appname) {
      throw new Error('Invalid appname.');
    }
    const result = await dbCli.getUserBackups(owner, appname);
    const checkpoints = [];
    if (Array.isArray(result)) {
      const temp = {};
      let i = 0;
      for (; i < result.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(temp, result[i].timestamp)) {
          temp[result[i].timestamp].components.push({ component_name: result[i].component, hash: result[i].hash, filesize: result[i].filesize });
        } else {
          if (i > 0) {
            checkpoints.push({ timestamp: result[i - 1].timestamp, components: temp[result[i - 1].timestamp].components });
          }
          temp[result[i].timestamp] = { components: [{ component_name: result[i].component, hash: result[i].hash, filesize: result[i].filesize }] };
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
module.exports = {
  init,
  registerBackupTask,
  getBackupList,
};
