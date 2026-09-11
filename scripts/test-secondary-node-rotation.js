const assert = require('assert');
const axios = require('axios');
const log = require('../src/lib/log');
const fluxOS = require('../src/services/fluxOsService');

const originalAxiosGet = axios.get;
const originalLogError = log.error;
const originalLogInfo = log.info;
const originalLogWarn = log.warn;

async function main() {
  log.error = () => {};
  log.info = () => {};
  log.warn = () => {};
  axios.get = async (url) => {
    if (url.includes('/fluxstatistics')) {
      return { status: 200, data: '<html><body>No healthy secondary</body></html>' };
    }
    if (url.includes('/api/appips/')) {
      return {
        status: 200,
        data: { status: 'success', data: { ips: ['10.0.0.1'] } },
      };
    }
    if (url.includes('/apps/location/')) {
      return {
        status: 200,
        data: {
          status: 'success',
          data: [
            { ip: '10.0.0.1:16127' },
            { ip: '10.0.0.2:16137' },
            { ip: '10.0.0.3:16147' },
          ],
        },
      };
    }
    throw new Error(`Unexpected URL in test: ${url}`);
  };

  const attemptedNodes = new Set();
  const first = await fluxOS.getSecondaryNodeSelection('palworld-test', attemptedNodes);
  assert.strictEqual(first.node, '10.0.0.2:16137');
  attemptedNodes.add(first.node);

  const second = await fluxOS.getSecondaryNodeSelection('palworld-test', attemptedNodes);
  assert.strictEqual(second.node, '10.0.0.3:16147');
  attemptedNodes.add(second.node);

  const exhausted = await fluxOS.getSecondaryNodeSelection('palworld-test', attemptedNodes);
  assert.strictEqual(exhausted.node, '10.0.0.2:16137');
  assert(
    exhausted.diagnostics.some(
      (diagnostic) => diagnostic.detail.includes('All distinct secondary locations'),
    ),
  );

  console.log('Secondary node rotation tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    axios.get = originalAxiosGet;
    log.error = originalLogError;
    log.info = originalLogInfo;
    log.warn = originalLogWarn;
  });
