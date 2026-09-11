const assert = require('assert');
const { PassThrough } = require('stream');
const { asyncRoute } = require('../src/routes');
const idService = require('../src/services/idService');

async function main() {
  const expectedError = new Error('route failed');
  let forwardedError = null;
  const failingRoute = asyncRoute(async () => {
    throw expectedError;
  });
  await failingRoute({}, {}, (error) => {
    forwardedError = error;
  });
  assert.strictEqual(forwardedError, expectedError);

  let completed = false;
  const successfulRoute = asyncRoute(async () => {
    completed = true;
  });
  await successfulRoute({}, {}, () => {
    throw new Error('next should not be called for successful handlers');
  });
  assert.strictEqual(completed, true);

  const parsedBody = { address: 'test-address' };
  assert.strictEqual(
    await idService.testHooks.readLoginBody({ body: parsedBody }),
    parsedBody,
  );

  const requestStream = new PassThrough();
  requestStream.body = undefined;
  requestStream.readableEnded = false;
  const streamedBody = idService.testHooks.readLoginBody(requestStream);
  requestStream.end('address=test-address&signature=test-signature');
  assert.deepStrictEqual(await streamedBody, {
    address: 'test-address',
    signature: 'test-signature',
  });

  console.log('HTTP async error boundary tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
