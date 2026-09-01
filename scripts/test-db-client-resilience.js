const assert = require('assert');
const config = require('../config/default');
const log = require('../src/lib/log');
const { DBClient, serializeStatus } = require('../src/services/utils/DBClient');

const originalOperationTimeout = config.dbOperationTimeoutMs;
const originalSlowQuery = config.dbSlowQueryMs;
const originalLogError = log.error;
const originalLogWarn = log.warn;

function createClient(connection) {
  const client = new DBClient();
  client.connection = connection;
  client.connected = true;
  return client;
}

async function main() {
  log.error = () => {};
  log.warn = () => {};
  config.dbOperationTimeoutMs = 30;
  config.dbSlowQueryMs = 1000;

  let readAttempts = 0;
  const retryingClient = createClient({
    execute: async (options) => {
      readAttempts += 1;
      assert.strictEqual(options.timeout, config.dbQueryTimeoutMs);
      if (readAttempts === 1) {
        const error = new Error('stale pooled connection');
        error.code = 'ECONNRESET';
        throw error;
      }
      return [[{ taskId: 1 }], []];
    },
  });
  const rows = await retryingClient.execute('SELECT taskId FROM tasks WHERE taskId = ?', [1]);
  assert.deepStrictEqual(rows, [{ taskId: 1 }]);
  assert.strictEqual(readAttempts, 2);

  let writeAttempts = 0;
  const writeClient = createClient({
    execute: async () => {
      writeAttempts += 1;
      const error = new Error('connection lost during write');
      error.code = 'ECONNRESET';
      throw error;
    },
  });
  await assert.rejects(
    writeClient.execute('UPDATE tasks SET uploaded = 1 WHERE taskId = ?', [1]),
    /connection lost during write/,
  );
  assert.strictEqual(writeAttempts, 1);

  const hangingClient = createClient({
    execute: async () => new Promise(() => {}),
  });
  await assert.rejects(
    hangingClient.execute('SELECT taskId FROM tasks', []),
    (error) => error.code === 'DB_OPERATION_TIMEOUT',
  );

  const longStatus = {
    state: 'failed',
    message: `SQL failed: ${'very long database error '.repeat(30)}`,
    progress: 0,
    diagnostic: 'this optional field is deliberately discarded when oversized',
  };
  const serializedStatus = serializeStatus(longStatus);
  assert(serializedStatus.length <= 256);
  assert.strictEqual(JSON.parse(serializedStatus).state, 'failed');
  assert(JSON.parse(serializedStatus).message.endsWith('...'));

  let updateParams;
  const statusClient = createClient({
    execute: async (options, params) => {
      updateParams = params;
      return [{ affectedRows: 1 }, []];
    },
  });
  await statusClient.updateTask({ taskId: 42, status: longStatus });
  assert(updateParams[0].length <= 256);
  assert.doesNotThrow(() => JSON.parse(updateParams[0]));

  await statusClient.updateTask({ taskId: 43, status: JSON.stringify(longStatus) });
  assert(updateParams[0].length <= 256);
  assert.doesNotThrow(() => JSON.parse(updateParams[0]));

  console.log('DB client resilience tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    config.dbOperationTimeoutMs = originalOperationTimeout;
    config.dbSlowQueryMs = originalSlowQuery;
    log.error = originalLogError;
    log.warn = originalLogWarn;
  });
