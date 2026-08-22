const assert = require('assert');

const log = require('../src/lib/log');
const { testHooks } = require('../src/services/backupService');

const originalLogError = log.error;
const originalLogWarn = log.warn;
const originalLogInfo = log.info;

const candidate = {
  id: 42,
  appname: 'palworld-test',
  status: 'done',
  last_backup_timestamp: 1000,
  is_marketplace: 1,
};

function createDatabase({ claimResult, claimError, confirmation = [] }) {
  return {
    async execute(sql) {
      if (sql.includes('SELECT *')) return [candidate];
      if (sql.includes('SET dispatch_token')) {
        if (claimError) throw claimError;
        return claimResult;
      }
      if (sql.includes('SELECT id')) return confirmation;
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

async function main() {
  log.error = () => {};
  log.warn = () => {};
  log.info = () => {};

  const now = Date.parse('2026-08-21T10:00:00.000Z');
  const claimed = await testHooks.claimNextAutomaticBackup(
    createDatabase({ claimResult: { affectedRows: 1 } }),
    now,
    'claim-token',
  );
  assert.strictEqual(claimed.id, candidate.id);
  assert.strictEqual(claimed.dispatch_token, 'claim-token');
  assert.strictEqual(claimed.last_backup_timestamp, now);
  assert(claimed.dispatch_lease_until > now);

  const lost = await testHooks.claimNextAutomaticBackup(
    createDatabase({ claimResult: { affectedRows: 0 } }),
    now,
    'lost-token',
  );
  assert.strictEqual(lost, null);

  const timeout = new Error('Query inactivity timeout');
  const recovered = await testHooks.claimNextAutomaticBackup(
    createDatabase({ claimError: timeout, confirmation: [{ id: candidate.id }] }),
    now,
    'recovered-token',
  );
  assert.strictEqual(recovered.dispatch_token, 'recovered-token');

  const unconfirmed = await testHooks.claimNextAutomaticBackup(
    createDatabase({ claimError: timeout, confirmation: [] }),
    now,
    'unconfirmed-token',
  );
  assert.strictEqual(unconfirmed, null);

  const automaticBackup = {
    ...candidate,
    dispatch_token: 'completion-token',
  };
  const completionTasks = [10, 11];
  const completed = await testHooks.persistAutomaticBackupCompletion({
    execute: async (sql) => {
      assert(sql.includes('UPDATE automatic_backups'));
      return { affectedRows: 1 };
    },
  }, automaticBackup, completionTasks, 0);
  assert.deepStrictEqual(completed, {
    canonicalTaskIds: completionTasks,
    duplicateTaskIds: [],
  });

  let completionCalls = 0;
  const confirmedAfterTimeout = await testHooks.persistAutomaticBackupCompletion({
    execute: async (sql) => {
      completionCalls += 1;
      if (sql.includes('UPDATE automatic_backups')) throw timeout;
      return [{ status: 'done', backup_tasks: '[10,11]', dispatch_token: null }];
    },
  }, automaticBackup, completionTasks, 0);
  assert.deepStrictEqual(confirmedAfterTimeout, {
    canonicalTaskIds: completionTasks,
    duplicateTaskIds: [],
  });
  assert.strictEqual(completionCalls, 2);

  let retryUpdateCalls = 0;
  const completedOnDatabaseRetry = await testHooks.persistAutomaticBackupCompletion({
    execute: async (sql) => {
      if (sql.includes('UPDATE automatic_backups')) {
        retryUpdateCalls += 1;
        if (retryUpdateCalls === 1) throw timeout;
        return { affectedRows: 1 };
      }
      return [{
        status: 'pending',
        backup_tasks: null,
        dispatch_token: 'completion-token',
        last_backup_timestamp: automaticBackup.last_backup_timestamp,
      }];
    },
  }, automaticBackup, completionTasks, 0);
  assert.strictEqual(retryUpdateCalls, 2);
  assert.deepStrictEqual(completedOnDatabaseRetry, {
    canonicalTaskIds: completionTasks,
    duplicateTaskIds: [],
  });

  const priorAttemptCompleted = await testHooks.persistAutomaticBackupCompletion({
    execute: async (sql) => {
      if (sql.includes('UPDATE automatic_backups')) return { affectedRows: 0 };
      return [{
        status: 'done',
        backup_tasks: '[7]',
        dispatch_token: null,
        last_backup_timestamp: automaticBackup.last_backup_timestamp,
      }];
    },
  }, automaticBackup, completionTasks, 0);
  assert.deepStrictEqual(priorAttemptCompleted, {
    canonicalTaskIds: [7],
    duplicateTaskIds: completionTasks,
  });

  await assert.rejects(
    testHooks.persistAutomaticBackupCompletion({
      execute: async (sql) => {
        if (sql.includes('UPDATE automatic_backups')) throw timeout;
        return [{ status: 'pending', backup_tasks: null, dispatch_token: 'completion-token' }];
      },
    }, automaticBackup, completionTasks, 0),
    /Backup files uploaded, but completion could not be confirmed/,
  );

  let releaseDispatcher;
  let dispatcherRuns = 0;
  const activeDispatcher = testHooks.runAutomaticBackupDispatcher(async () => {
    dispatcherRuns += 1;
    await new Promise((resolve) => { releaseDispatcher = resolve; });
    return true;
  }, 1);
  assert.strictEqual(
    await testHooks.runAutomaticBackupDispatcher(async () => {
      dispatcherRuns += 1;
      return true;
    }, 1),
    false,
  );
  assert.strictEqual(dispatcherRuns, 1);
  releaseDispatcher();
  assert.strictEqual(await activeDispatcher, true);
  assert.strictEqual(
    await testHooks.runAutomaticBackupDispatcher(async () => {
      dispatcherRuns += 1;
      return true;
    }, 1),
    true,
  );
  assert.strictEqual(dispatcherRuns, 2);

  const concurrentReleases = [];
  const concurrentRuns = [1, 2, 3].map(() => testHooks.runAutomaticBackupDispatcher(
    async () => new Promise((resolve) => { concurrentReleases.push(resolve); }),
    3,
  ));
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(concurrentReleases.length, 3);
  assert.strictEqual(
    await testHooks.runAutomaticBackupDispatcher(async () => true, 3),
    false,
  );
  concurrentReleases.forEach((release) => { release(true); });
  assert.deepStrictEqual(await Promise.all(concurrentRuns), [true, true, true]);

  assert.strictEqual(testHooks.inferFailureStage(timeout), 'database');
  assert.strictEqual(
    testHooks.inferFailureStage(new Error('Database operation timed out after 20000ms')),
    'database',
  );

  const payload = {
    stage: 'database',
    reason: 'Query inactivity timeout',
    taskFailures: [{ component: 'palworld', message: 'timeout' }],
  };
  assert.strictEqual(
    testHooks.buildAutomaticFailureFingerprint(payload),
    testHooks.buildAutomaticFailureFingerprint({ ...payload }),
  );

  let notificationReservations = 0;
  let discordMessages = 0;
  const dedupeDatabase = {
    execute: async () => {
      notificationReservations += 1;
      return { affectedRows: notificationReservations === 1 ? 1 : 0 };
    },
  };
  const notifier = {
    notifyAutomaticBackupFailure: async () => {
      discordMessages += 1;
      return true;
    },
  };
  await testHooks.notifyAutomaticBackupFailureOnce(
    automaticBackup,
    payload,
    dedupeDatabase,
    notifier,
    new Map(),
  );
  await testHooks.notifyAutomaticBackupFailureOnce(
    automaticBackup,
    payload,
    dedupeDatabase,
    notifier,
    new Map(),
  );
  assert.strictEqual(discordMessages, 1);

  discordMessages = 0;
  const fallbackCache = new Map();
  const unavailableDatabase = { execute: async () => { throw timeout; } };
  await testHooks.notifyAutomaticBackupFailureOnce(
    automaticBackup,
    payload,
    unavailableDatabase,
    notifier,
    fallbackCache,
  );
  await testHooks.notifyAutomaticBackupFailureOnce(
    automaticBackup,
    payload,
    unavailableDatabase,
    notifier,
    fallbackCache,
  );
  assert.strictEqual(discordMessages, 1);

  console.log('automatic backup dispatch tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    log.error = originalLogError;
    log.warn = originalLogWarn;
    log.info = originalLogInfo;
  });
