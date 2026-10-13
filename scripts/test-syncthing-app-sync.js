const assert = require('assert');
const { testHooks } = require('../src/services/backupService');
const backupService = require('../src/services/backupService');
const fluxOS = require('../src/services/fluxOsService');
const marketplaceService = require('../src/services/marketplaceService');
const log = require('../src/lib/log');

assert.strictEqual(testHooks.normalizeAppName('dcmsbackend'), 'dcmsbackend');
assert.strictEqual(testHooks.normalizeAppName('DCMSBackend'), 'dcmsbackend');
assert.strictEqual(testHooks.normalizeAppName('  palworld1788433315709  '), 'palworld1788433315709');
assert.strictEqual(testHooks.normalizeAppName(null), '');

const existingApps = [{ appname: 'dcmsbackend' }];
const existingAppsByName = new Map(
  existingApps.map((app) => [testHooks.normalizeAppName(app.appname), app]),
);
const discoveredApps = [
  { appName: 'DCMSBackend' },
  { appName: 'palworld1788433315709' },
];
const newApps = discoveredApps.filter(
  (app) => !existingAppsByName.has(testHooks.normalizeAppName(app.appName)),
);

assert.deepStrictEqual(newApps, [{ appName: 'palworld1788433315709' }]);

async function testIdempotentUpsert() {
  let capturedSql;
  let capturedParams;
  const database = {
    async execute(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      return { affectedRows: 2 };
    },
  };

  const result = await testHooks.upsertAutomaticBackupApp(database, {
    appName: 'palworld1788433315709',
    componentNames: ['palworld'],
  }, 1);

  assert.strictEqual(result.affectedRows, 2);
  assert.match(capturedSql, /ON DUPLICATE KEY UPDATE/);
  assert.deepStrictEqual(capturedParams, [
    'palworld1788433315709',
    '["palworld"]',
    1,
  ]);
}

async function testPerRecordFailureIsolation() {
  const originalDiscover = fluxOS.discoverAppsWithSyncthing;
  const originalGetTemplates = marketplaceService.getMarketplaceTemplates;
  const originalLogInfo = log.info;
  const originalLogError = log.error;
  const completedOperations = [];
  const errors = [];
  let cacheInsert = 0;

  const database = {
    async execute(sql, params = []) {
      if (sql.includes('SELECT appname, components')) {
        return [
          { appname: 'existing-present-a', components: '["a"]', is_marketplace: null },
          { appname: 'existing-present-b', components: '["b"]', is_marketplace: null },
          { appname: 'expired-fail', components: '["old"]', is_marketplace: 0 },
          { appname: 'expired-success', components: '["old"]', is_marketplace: 0 },
        ];
      }
      if (sql.includes('SELECT appname, spec_hash')) return [];
      if (sql.includes('INSERT INTO enterprise_app_discovery')) {
        cacheInsert += 1;
        if (cacheInsert === 1) throw new Error('cache row failed');
        completedOperations.push('cache-success');
        return { affectedRows: 1 };
      }
      if (sql.includes('DELETE FROM enterprise_app_discovery')) {
        throw new Error('cache cleanup failed');
      }
      if (sql.includes('INSERT INTO automatic_backups')) {
        if (params[0] === 'new-fail') throw new Error('new app failed');
        completedOperations.push(`insert:${params[0]}`);
        return { affectedRows: 1 };
      }
      if (sql.includes('SET is_marketplace')) {
        if (params[1] === 'existing-present-a') throw new Error('classification failed');
        completedOperations.push(`classification:${params[1]}`);
        return { affectedRows: 1 };
      }
      if (sql.includes('SET expire_counter')) {
        if (params[0] === 'expired-fail') throw new Error('expiration failed');
        completedOperations.push(`expiration:${params[0]}`);
        return { affectedRows: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  try {
    testHooks.setDatabaseForTests(database);
    fluxOS.discoverAppsWithSyncthing = async () => ({
      apps: [
        { appName: 'existing-present-a', componentNames: ['a'], repotags: ['repo:a'] },
        { appName: 'existing-present-b', componentNames: ['b'], repotags: ['repo:b'] },
        { appName: 'new-fail', componentNames: ['new'], repotags: ['repo:new'] },
        { appName: 'new-success', componentNames: ['new'], repotags: ['repo:new'] },
      ],
      cacheUpdates: [
        {
          appname: 'cache-fail', specHash: 'one', hasSyncthing: true, componentNames: [], repotags: [],
        },
        {
          appname: 'cache-success', specHash: 'two', hasSyncthing: true, componentNames: [], repotags: [],
        },
      ],
      currentEnterpriseAppNames: ['enterprise-current'],
      unresolvedEnterpriseAppNames: new Set(),
    });
    marketplaceService.getMarketplaceTemplates = async () => [
      { repotags: ['repo:a'] },
      { repotags: ['repo:b'] },
      { repotags: ['repo:new'] },
    ];
    log.info = () => {};
    log.error = (message) => { errors.push(String(message)); };

    await backupService.syncSyncthingApps();

    assert(completedOperations.includes('cache-success'));
    assert(completedOperations.includes('insert:new-success'));
    assert(completedOperations.includes('classification:existing-present-b'));
    assert(completedOperations.includes('expiration:expired-success'));
    assert(errors.some((message) => message.includes('cache-fail')));
    assert(errors.some((message) => message.includes('new-fail')));
    assert(errors.some((message) => message.includes('existing-present-a')));
    assert(errors.some((message) => message.includes('expired-fail')));
    assert(!errors.some((message) => message.includes('Error syncing Syncthing apps')));
  } finally {
    testHooks.setDatabaseForTests(null);
    fluxOS.discoverAppsWithSyncthing = originalDiscover;
    marketplaceService.getMarketplaceTemplates = originalGetTemplates;
    log.info = originalLogInfo;
    log.error = originalLogError;
  }
}

async function testManualSyncOverlapProtection() {
  let releaseFirstRun;
  const firstRunGate = new Promise((resolve) => { releaseFirstRun = resolve; });
  const firstRun = testHooks.runSyncthingSyncNow(async () => {
    await firstRunGate;
    return { success: true, discoveredApps: 1 };
  });

  const overlappingRun = await testHooks.runSyncthingSyncNow(async () => ({
    success: true,
  }));
  assert.deepStrictEqual(overlappingRun, {
    started: false,
    reason: 'Syncthing discovery is already running',
  });

  releaseFirstRun();
  assert.deepStrictEqual(await firstRun, {
    started: true,
    result: { success: true, discoveredApps: 1 },
  });

  await assert.rejects(
    testHooks.runSyncthingSyncNow(async () => { throw new Error('forced failure'); }),
    /forced failure/,
  );
  const runAfterFailure = await testHooks.runSyncthingSyncNow(async () => ({ success: true }));
  assert.strictEqual(runAfterFailure.started, true);
}

Promise.all([
  testIdempotentUpsert(),
  testPerRecordFailureIsolation(),
  testManualSyncOverlapProtection(),
]).then(() => {
  console.log('Syncthing app sync normalization and idempotency tests passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
