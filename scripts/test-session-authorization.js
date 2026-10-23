/* eslint-disable no-await-in-loop */
const assert = require('assert');
const crypto = require('crypto');
const qs = require('qs');
const bitcoinMessage = require('../src/services/utils/bitcoinMessage');
const idService = require('../src/services/idService');
const backupService = require('../src/services/backupService');
const fluxOS = require('../src/services/fluxOsService');
const log = require('../src/lib/log');

function identity() {
  const privateKey = crypto.randomBytes(32);
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(privateKey);
  return { privateKey, address: bitcoinMessage.publicKeyToAddress(ecdh.getPublicKey(null, 'compressed')) };
}

function authenticate(message, signer) {
  return {
    zelid: signer.address,
    loginPhrase: message,
    signature: bitcoinMessage.sign(message, signer.privateKey, true).toString('base64'),
  };
}

async function invoke(handler, request) {
  let response;
  await handler(request, {
    headersSent: false,
    json: (value) => { response = value; },
  });
  assert(response, 'Handler must send a response');
  return response;
}

async function main() {
  const originalNow = Date.now;
  const originalInfo = log.info;
  const originalError = log.error;
  const originalIsTeamFluxId = fluxOS.isTeamFluxId;
  const originalDatabase = backupService.getDatabase();
  const now = Date.now();
  const windowMs = 1.5 * 60 * 60 * 1000;
  const owner = identity();
  const stranger = identity();
  const team = identity();
  const sessionPhrases = new Set();
  const phrase = (timestamp, length = 40) => `${timestamp}${'a'.repeat(length - 13)}`;
  const headers = (auth) => ({ zelidauth: JSON.stringify(auth) });
  const login = (auth) => invoke(idService.verifyLogin, { body: auth });

  Date.now = () => now;
  log.info = () => {};
  log.error = () => {};
  try {
    // Use real signatures over synthetic public app messages, with no stored session.
    const appMessage = `fluxappregister1${JSON.stringify({ name: 'test-app', owner: owner.address })}${now - windowMs * 2}`;
    const invalidMessages = [
      appMessage,
      'n'.repeat(40),
      phrase(now, 39),
      phrase(now, 71),
      ` ${now.toString().slice(1)}${'a'.repeat(27)}`,
      `1e12${'a'.repeat(36)}`,
      `123456789012x${'a'.repeat(27)}`,
      `１２３４５６７８９０１２３${'a'.repeat(27)}`,
      phrase(now - windowMs - 1),
      phrase(now + 1),
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const message of invalidMessages) {
      const auth = authenticate(message, owner);
      assert.strictEqual(await idService.verifyUserSession(headers(auth)), false, `Session accepted invalid phrase: ${message}`);
      assert.strictEqual((await login(auth)).status, 'error', `Login accepted invalid phrase: ${message}`);
    }

    // Reject malformed phrases even if an older process already cached them.
    const cachedReplay = authenticate(appMessage, owner);
    idService.addNewSession(appMessage, cachedReplay);
    sessionPhrases.add(appMessage);
    assert.strictEqual(await idService.verifyUserSession(headers(cachedReplay)), false);

    // Boundary lengths/timestamps and both supported header encodings still work.
    const validMessages = [phrase(now), phrase(now, 70), phrase(now - windowMs)];
    // eslint-disable-next-line no-restricted-syntax
    for (const message of validMessages) {
      const auth = authenticate(message, owner);
      assert.strictEqual(await idService.verifyUserSession(headers(auth)), owner.address);
      assert.strictEqual(await idService.verifyUserSession({ zelidauth: qs.stringify(auth) }), owner.address);
      sessionPhrases.add(message);
      assert.strictEqual((await login(auth)).status, 'success');
      assert.strictEqual(await idService.verifyUserSession(headers(auth)), owner.address);
      const wrongSigner = authenticate(message, stranger);
      wrongSigner.zelid = owner.address;
      assert.strictEqual(await idService.verifyUserSession(headers(wrongSigner)), false);
      assert.strictEqual((await login(wrongSigner)).status, 'error');
    }

    // Keep the existing sliding lifetime for correctly formatted issued sessions.
    const cachedPhrase = phrase(now - windowMs - 10);
    const cachedAuth = authenticate(cachedPhrase, owner);
    idService.addNewSession(cachedPhrase, cachedAuth);
    sessionPhrases.add(cachedPhrase);
    assert.strictEqual(await idService.verifyUserSession(headers(cachedAuth)), owner.address);
    idService.removeSession(cachedPhrase);
    assert.strictEqual(await idService.verifyUserSession(headers(cachedAuth)), false);

    const malformedAuth = [null, {}, { zelid: owner.address, signature: 'test', loginPhrase: 123 }];
    // eslint-disable-next-line no-restricted-syntax
    for (const auth of malformedAuth) {
      assert.strictEqual(await idService.verifyUserSession(headers(auth)), false);
      assert.strictEqual((await login(auth)).status, 'error');
    }

    const task = {
      taskId: 42,
      owner: owner.address,
      appname: 'test-app',
      status: { state: 'finished', message: 'backup complete' },
    };
    let databaseReads = 0;
    backupService.testHooks.setDatabaseForTests({
      getTask: async (taskId) => {
        databaseReads += 1;
        return Number(taskId) === task.taskId ? task : null;
      },
    });
    fluxOS.isTeamFluxId = async (address) => address === team.address;
    const taskStatus = (auth, taskId = 42) => invoke(backupService.getTaskStatus, {
      headers: headers(auth), query: { taskId },
    });
    const ownerAuth = authenticate(phrase(now), owner);
    const strangerAuth = authenticate(phrase(now), stranger);
    const teamAuth = authenticate(phrase(now), team);
    assert.strictEqual((await taskStatus(ownerAuth)).status, 'success');
    const denied = await taskStatus(strangerAuth);
    assert.strictEqual(denied.status, 'error');
    assert.strictEqual(denied.data.message, 'Unauthorized. Access denied.');
    assert(!denied.data.status, 'Unauthorized responses must not include task status');
    assert.strictEqual((await taskStatus(teamAuth)).status, 'success');
    assert.strictEqual((await taskStatus(ownerAuth, 43)).status, 'error');
    assert.strictEqual(databaseReads, 4);
    assert.strictEqual((await taskStatus(cachedReplay)).status, 'error');
    assert.strictEqual(databaseReads, 4, 'Replay must be rejected before reading tasks');
  } finally {
    sessionPhrases.forEach((message) => idService.removeSession(message));
    Date.now = originalNow;
    log.info = originalInfo;
    log.error = originalError;
    fluxOS.isTeamFluxId = originalIsTeamFluxId;
    backupService.testHooks.setDatabaseForTests(originalDatabase);
  }
  console.log('Session and task authorization tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
