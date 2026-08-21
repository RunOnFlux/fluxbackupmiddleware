const assert = require('assert');
const axios = require('axios');
const log = require('../src/lib/log');
const fluxOS = require('../src/services/fluxOsService');

const originalAxiosGet = axios.get;
const originalLogError = log.error;

async function main() {
  log.error = () => {};
  axios.get = async () => ({
    status: 200,
    data: {
      status: 'error',
      data: {
        message: 'Flux communication is limited, other nodes cannot reach yours',
      },
    },
  });
  const rejected = await fluxOS.getLoginPhraseDetailed('http://23.226.161.131:16147');
  assert.strictEqual(rejected.phrase, null);
  assert(rejected.reason.includes('unavailable for backup authentication'));
  assert(rejected.reason.includes('error response'));
  assert(!rejected.reason.includes('Flux communication is limited'));
  assert.strictEqual(rejected.diagnostic.httpStatus, 200);
  assert.strictEqual(
    rejected.diagnostic.detail,
    'Node API responded but did not provide a login phrase',
  );

  axios.get = async () => {
    const error = new Error('connect ETIMEDOUT 23.226.161.131:16147');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  const unreachable = await fluxOS.getLoginPhraseDetailed('http://23.226.161.131:16147');
  assert.strictEqual(unreachable.phrase, null);
  assert(unreachable.reason.includes('Selected Flux node API is unreachable'));
  assert(unreachable.reason.includes('ETIMEDOUT'));
  assert.strictEqual(unreachable.diagnostic.errorCode, 'ETIMEDOUT');

  console.log('Flux node authentication diagnostic tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    axios.get = originalAxiosGet;
    log.error = originalLogError;
  });
