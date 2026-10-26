/* eslint-disable no-await-in-loop, no-promise-executor-return, no-param-reassign */
const assert = require('assert');
const config = require('../config/default');
const backup = require('../src/services/backupService');
const files = require('../src/services/fileService');
const fluxOS = require('../src/services/fluxOsService');
const idService = require('../src/services/idService');
const log = require('../src/lib/log');

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function main() {
  const savedConfig = { maxConcurrentTasks: config.maxConcurrentTasks, maxConcurrentTasksPerOwner: config.maxConcurrentTasksPerOwner };
  const savedFiles = { fileExists: files.fileExists, downloadFileFromHost: files.downloadFileFromHost };
  const savedFlux = { verifyAppOwner: fluxOS.verifyAppOwner, getAppExpireHeight: fluxOS.getAppExpireHeight };
  const savedVerify = idService.verifyUserSession;
  const savedLogs = {
    info: log.info, error: log.error, warn: log.warn, debug: log.debug,
  };
  Object.keys(savedLogs).forEach((key) => { log[key] = () => {}; });
  const releases = new Map();
  const starts = [];
  const rows = [
    { taskId: 1, owner: 'owner-a', timestamp: 9999999999999 },
    { taskId: 2, owner: 'owner-a', timestamp: 1 },
    { taskId: 3, owner: 'owner-b', timestamp: 2 },
  ].map((row) => ({
    ...row, startTime: 0, finishTime: 0, uploaded: 1, fails: 0, localRemoved: 1, appname: 'test-app', filesize: 4,
  }));
  let duplicate = null;
  let pendingOwner = 0;
  let pendingManual = 0;
  let insertions = 0;
  let queueReads = 0;
  const database = {
    execute: async (sql, params = []) => {
      if (sql.includes('ORDER BY startTime, taskId')) {
        queueReads += 1;
        assert(!sql.includes('order by timestamp'));
        assert(!sql.includes('ORDER BY timestamp'));
        const excludedIds = params.filter((value) => typeof value === 'number');
        const excludedOwners = params.filter((value) => typeof value === 'string');
        return rows.filter((row) => !row.finishTime && !excludedIds.includes(row.taskId) && !excludedOwners.includes(row.owner))
          .sort((a, b) => a.startTime - b.startTime || a.taskId - b.taskId).slice(0, config.maxConcurrentTasks);
      }
      if (sql.includes('AS ownerPending')) return [{ ownerPending: pendingOwner, manualPending: pendingManual }];
      if (sql.includes('AND timestamp = ?')) return duplicate ? [duplicate] : [];
      return [];
    },
    updateTask: async () => {},
    getTask: async (id) => rows.find((row) => row.taskId === id),
    addNewTask: async () => { insertions += 1; return { insertId: 100 + insertions }; },
  };
  backup.testHooks.setDatabaseForTests(database);
  files.fileExists = () => false;
  files.downloadFileFromHost = async (task) => {
    starts.push(task.taskId);
    await new Promise((resolve) => releases.set(task.taskId, resolve));
    task.downloaded = true;
  };
  config.maxConcurrentTasks = 2;
  config.maxConcurrentTasksPerOwner = 1;
  try {
    await Promise.all([backup.testHooks.updateQueue(), backup.testHooks.updateQueue()]);
    await tick();
    assert.deepStrictEqual(starts, [1, 3], 'Server FIFO plus per-owner concurrency must leave capacity for another owner');
    assert.strictEqual(backup.testHooks.getActiveTasks().length, 2);
    rows[0].startTime = Math.floor(Date.now() / 1000) - 3600;
    const reads = queueReads;
    await backup.testHooks.updateQueue();
    assert.strictEqual(queueReads, reads, 'An old live task must retain its concurrency slot');
    assert.deepStrictEqual(starts, [1, 3]);
    // Re-registering a live checkpoint must not create a second runner.
    duplicate = { ...rows[0], uploaded: 0 };
    fluxOS.verifyAppOwner = async () => true;
    fluxOS.getAppExpireHeight = async () => 9999999;
    idService.verifyUserSession = async () => 'owner-a';
    const body = {
      appname: 'test-app', component: 'app', timestamp: '1', filename: 'backup.tar.gz', filesize: '4', host: 'https://node.example/backup',
    };
    const register = async () => {
      let response;
      await backup.registerBackupTask({ body, query: {}, headers: { zelidauth: 'synthetic-owner-token' } }, { json: (value) => { response = value; } });
      return response;
    };
    assert.strictEqual((await register()).status, 'success');
    assert.deepStrictEqual(starts, [1, 3]);
    releases.get(1)();
    releases.get(3)();
    for (let n = 0; n < 20 && backup.testHooks.getActiveTasks().length; n += 1) await tick();
    assert.strictEqual(backup.testHooks.getActiveTasks().length, 0);
    await backup.testHooks.updateQueue();
    await tick();
    assert.deepStrictEqual(starts, [1, 3, 2]);
    releases.get(2)();
    for (let n = 0; n < 20 && backup.testHooks.getActiveTasks().length; n += 1) await tick();
    config.maxConcurrentTasks = 0;
    const waiting = {
      taskId: 99, owner: 'owner-a', uploaded: 0, extra: 'expired-auth',
    };
    rows.push(waiting);
    duplicate = waiting;
    assert.strictEqual((await register()).status, 'success');
    assert.strictEqual(waiting.extra, 'synthetic-owner-token', 'A queued task can refresh authentication even when concurrency is full');
    assert.strictEqual(backup.testHooks.getActiveTasks().length, 0);
    duplicate = null;
    pendingOwner = config.maxPendingTasksPerOwner;
    assert.strictEqual((await register()).status, 'error');
    assert.strictEqual(insertions, 0);
    pendingOwner = 0;
    pendingManual = config.maxPendingManualTasks;
    assert.strictEqual((await register()).status, 'error');
    assert.strictEqual(insertions, 0);
    pendingManual = 0;
    assert.strictEqual((await register()).status, 'success');
    assert.strictEqual(insertions, 1);
    // Once insertion becomes visible, simultaneous duplicates share one task.
    const add = database.addNewTask;
    database.addNewTask = async (...args) => {
      const result = await add(...args);
      duplicate = { taskId: result.insertId, uploaded: 0 };
      return result;
    };
    const responses = await Promise.all([register(), register(), register()]);
    assert(responses.every((response) => response.status === 'success'));
    assert.strictEqual(insertions, 2, 'Concurrent duplicate registration inserts only once');
    backup.testHooks.resetRegistrationLimits();
    for (let n = 0; n < 60; n += 1) backup.testHooks.consumeRegistration('owner-a');
    assert.throws(() => backup.testHooks.consumeRegistration('owner-a'), (error) => error.code === 'BACKUP_RATE_LIMIT');
    backup.testHooks.consumeRegistration('owner-b');
    console.log('Task admission, fairness, duplicate and live-slot ownership tests passed');
  } finally {
    releases.forEach((resolve) => resolve());
    await tick();
    Object.assign(config, savedConfig);
    Object.assign(files, savedFiles);
    Object.assign(fluxOS, savedFlux);
    Object.assign(log, savedLogs);
    idService.verifyUserSession = savedVerify;
    backup.testHooks.resetRegistrationLimits();
    backup.testHooks.setDatabaseForTests(null);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
