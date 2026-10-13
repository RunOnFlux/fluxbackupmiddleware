const assert = require('assert');
const config = require('../config/default');
const fluxDrive = require('../src/services/fluxDrive');
const log = require('../src/lib/log');
const { testHooks } = require('../src/services/backupService');

async function main() {
  const originalRemove = fluxDrive.removeFileVerified;
  const originalInfo = log.info;
  const originalLimit = config.maxUploadedBackupsPerApp;
  const removed = [];
  const marked = [];
  let failRemoval = false;
  let tasks = [];
  for (let timestamp = 1; timestamp <= 9; timestamp += 1) {
    tasks.push({
      taskId: timestamp * 2, appname: 'app-a', timestamp, hash: `hash-${timestamp}-a`,
    });
    tasks.push({
      taskId: timestamp * 2 + 1, appname: 'app-a', timestamp, hash: `hash-${timestamp}-b`,
    });
  }
  testHooks.setDatabaseForTests({
    execute: async (sql, params) => {
      assert.deepStrictEqual(params, ['owner-a', 'app-a']);
      assert(sql.includes('pending.owner = retained.owner'));
      assert(sql.includes('pending.timestamp = retained.timestamp'));
      assert(sql.includes('pending.uploaded = 0 OR pending.finishTime = 0'));
      return tasks;
    },
    softRemoveTask: async (id) => { marked.push(id); return { affectedRows: 1 }; },
  });
  fluxDrive.removeFileVerified = async (hash) => {
    if (failRemoval) throw new Error('FluxDrive unavailable');
    removed.push(hash);
    return { status: 'success' };
  };
  log.info = () => {};
  try {
    config.maxUploadedBackupsPerApp = 7;
    await testHooks.enforceAppBackupRetention('owner-a', 'app-a');
    assert.deepStrictEqual(marked, [2, 3, 4, 5]);
    assert.strictEqual(removed.length, 4);
    tasks = tasks.filter((task) => task.timestamp >= 3);
    await testHooks.enforceAppBackupRetention('owner-a', 'app-a');
    assert.strictEqual(removed.length, 4);
    config.maxUploadedBackupsPerApp = 6;
    failRemoval = true;
    await assert.rejects(testHooks.enforceAppBackupRetention('owner-a', 'app-a'), /unavailable/);
    assert.deepStrictEqual(marked, [2, 3, 4, 5]);
    failRemoval = false;
    await testHooks.enforceAppBackupRetention('owner-a', 'app-a');
    assert.deepStrictEqual(marked, [2, 3, 4, 5, 6, 7]);
    config.maxUploadedBackupsPerApp = 0;
    await assert.rejects(testHooks.enforceAppBackupRetention('owner-a', 'app-a'), /positive integer/);
  } finally {
    config.maxUploadedBackupsPerApp = originalLimit;
    fluxDrive.removeFileVerified = originalRemove;
    log.info = originalInfo;
    testHooks.setDatabaseForTests(null);
  }
  console.log('App backup retention tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
