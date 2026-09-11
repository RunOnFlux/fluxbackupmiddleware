const assert = require('assert');
const { testHooks } = require('../src/services/backupService');

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

testIdempotentUpsert().then(() => {
  console.log('Syncthing app sync normalization and idempotency tests passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
