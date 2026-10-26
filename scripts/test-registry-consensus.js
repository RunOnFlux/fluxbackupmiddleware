/* eslint-disable no-await-in-loop, no-restricted-syntax */
const assert = require('assert');
const crypto = require('crypto');
const axios = require('axios');
const registry = require('../src/services/utils/registryConsensus');
const fluxOS = require('../src/services/fluxOsService');
const backupService = require('../src/services/backupService');
const fluxDrive = require('../src/services/fluxDrive');
const Vault = require('../src/services/Vault');
const log = require('../src/lib/log');
const wallet = require('../src/services/utils/bitcoinMessage');

function identity(number) {
  const key = Buffer.alloc(32);
  key[31] = number;
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(key);
  return { key, zelid: wallet.publicKeyToAddress(ecdh.getPublicKey(null, 'compressed')) };
}

async function main() {
  const victim = identity(3);
  const attacker = identity(4);
  const originalGet = axios.get;
  const originalGetKey = Vault.getKey;
  const originalRemove = fluxDrive.removeFileVerified;
  const originalLogs = { info: log.info, warn: log.warn, error: log.error };
  const originalDatabase = backupService.getDatabase();
  const pool = '# pxname,svname,status\napirunonfluxiobackend,server1_203.0.113.11,UP\napirunonfluxiobackend,server2_203.0.113.12,UP\napirunonfluxiobackend,server3_203.0.113.13,UP';
  let mode = 'rogue-owner';
  let discoveryFailure = false;
  let specRequests = 0;
  const requests = [];
  const removed = [];
  const spec = {
    name: 'victim', owner: victim.zelid, height: 1000000, expire: 1000, version: 8, compose: [],
  };
  const notFound = { status: 'error', data: { message: 'Application not found' } };
  axios.get = async (url, options) => {
    requests.push(url);
    assert.strictEqual(options.httpsAgent.options.rejectUnauthorized, true);
    assert.strictEqual(options.maxRedirects, 0);
    assert(!options.headers?.zelidauth, 'Registry queries must never carry an owner or team token');
    if (url === 'https://api.runonflux.io/fluxstatistics;csv') {
      if (discoveryFailure) throw new Error('Gateway statistics unavailable');
      return { status: 200, data: pool };
    }
    if (url.includes('/fluxstatistics?scope=')) {
      return { status: 200, data: '<tr class="backup_up"><td>203.0.113.200:16127</td></tr>' };
    }
    if (url.includes('/api/appips/')) return { status: 200, data: { status: 'success', data: { ips: ['198.51.100.1'] } } };
    const backend = /^https:\/\/203-0-113-(1[123])-16127\.node\.api\.runonflux\.io\//.exec(url);
    assert(backend, `Unexpected or unpinned API destination: ${url}`);
    const rogue = backend[1] === '11';
    if (url.endsWith('/daemon/getblockcount')) {
      return { status: 200, data: { status: 'success', data: rogue ? 90000000 : 2000000 } };
    }
    if (url.includes('/apps/location/')) {
      const ips = rogue ? ['203.0.113.200:16127', '203.0.113.200:16127'] : ['198.51.100.1:16127', '198.51.100.2:16137'];
      if (mode === 'no-quorum' && !rogue) throw new Error('Backend unavailable');
      return { status: 200, data: { status: 'success', data: ips.map((ip) => ({ ip })) } };
    }
    assert(url.includes('/apps/appspecifications/'));
    specRequests += 1;
    if (mode === 'no-quorum' && !rogue) throw new Error('Backend unavailable');
    if (mode === 'not-found' || (mode === 'rogue-not-found' && rogue)) return { status: 200, data: notFound };
    if (mode === 'no-quorum' || (mode === 'rogue-owner' && rogue)) {
      return { status: 200, headers: { fluxnode: 'pretending-to-be-another-backend' }, data: { status: 'success', data: { ...spec, owner: attacker.zelid } } };
    }
    if (mode === 'rogue-malformed' && rogue) return { status: 200, data: { status: 'success', data: { ...spec, name: 'different-app' } } };
    // Different object-key order does not create a spurious disagreement.
    const reversed = Object.fromEntries(Object.entries(spec).reverse());
    return { status: 200, data: { status: 'success', data: backend[1] === '12' ? spec : reversed } };
  };
  Vault.getKey = async () => null;
  fluxDrive.removeFileVerified = async (hash) => { removed.push(hash); return { status: 'success' }; };
  ['info', 'warn', 'error'].forEach((name) => { log[name] = () => {}; });
  try {
    registry.testHooks.clearCaches();
    const owners = await Promise.all([fluxOS.getAppOwner('victim'), fluxOS.getAppOwner('victim'), fluxOS.getAppOwner('victim')]);
    assert.deepStrictEqual(owners, [victim.zelid, victim.zelid, victim.zelid]);
    assert.strictEqual(specRequests, 3, 'Concurrent requests must share a confirmed lookup');
    assert.strictEqual(await fluxOS.verifyAppOwner(attacker.zelid, 'victim'), false);
    assert.strictEqual(await fluxOS.verifyAppOwner(victim.zelid, 'victim'), true);
    const returned = await registry.getAppSpecs('victim');
    returned.owner = attacker.zelid;
    assert.strictEqual((await registry.getAppSpecs('victim')).owner, victim.zelid, 'Callers must not mutate confirmed cache entries');

    const loginPhrase = `${Date.now()}${'a'.repeat(40)}`;
    const zelidauth = JSON.stringify({
      zelid: attacker.zelid, loginPhrase, signature: wallet.sign(loginPhrase, attacker.key, true).toString('base64'),
    });
    let backupReads = 0;
    backupService.testHooks.setDatabaseForTests({ getUserBackups: async () => { backupReads += 1; return []; } });
    let response;
    await backupService.getBackupList({ headers: { zelidauth }, query: { appname: 'victim' } }, {
      headersSent: false, setHeader: () => {}, json: (value) => { response = value; },
    });
    assert.strictEqual(response.status, 'error');
    assert.strictEqual(backupReads, 0, 'A rogue backend must not expose victim backups');

    const locations = await registry.getLocations('victim');
    assert.deepStrictEqual(locations, [{ ip: '198.51.100.1:16127' }, { ip: '198.51.100.2:16137' }]);
    const selected = await fluxOS.getSecondaryNodeSelection('victim');
    assert.strictEqual(selected.node, '198.51.100.2:16137', 'A single rogue location answer must not steer node selection');
    assert(selected.diagnostics.some((diagnostic) => diagnostic.detail.includes('not confirmed')));
    assert.strictEqual(await registry.getBlockHeight(), 2000000, 'An exaggerated height must not trigger premature cleanup');

    const updates = [];
    const softRemovals = [];
    backupService.testHooks.setDatabaseForTests({
      execute: async () => [{
        taskId: 42, appname: 'victim', owner: victim.zelid, appExpireHeight: 1, hash: 'victim-backup',
      }],
      updateTask: async (task) => { updates.push(task); },
      softRemoveTask: async (id) => { softRemovals.push(id); },
    });
    for (const attack of ['rogue-owner', 'rogue-not-found', 'no-quorum', 'rogue-malformed']) {
      mode = attack;
      registry.testHooks.clearCaches();
      await backupService.testHooks.checkExpiredApps();
      assert.strictEqual(removed.length, 0, `${attack} must not delete a backup`);
      assert.strictEqual(softRemovals.length, 0);
    }
    mode = 'no-quorum';
    registry.testHooks.clearCaches();
    assert.strictEqual((await fluxOS.getAppOwnerDetailed('victim')).owner, null);
    assert.strictEqual(await fluxOS.verifyAppOwner(attacker.zelid, 'victim'), false);
    assert.strictEqual(await fluxOS.getAppSpecs('victim', true), false, 'Failure is not proof that an app was deleted');
    assert.strictEqual(await fluxOS.isAppExpiredInGlobalSpecs('victim'), null);
    await assert.rejects(registry.getLocations('victim'), (error) => error.code === 'REGISTRY_CONSENSUS_UNAVAILABLE');

    // A failed quorum is never cached; a recovered majority works immediately.
    mode = 'healthy';
    assert.strictEqual(await fluxOS.getAppOwner('victim'), victim.zelid);
    mode = 'not-found';
    const requestsBeforeExpiry = specRequests;
    assert.strictEqual(await fluxOS.isAppExpiredInGlobalSpecs('victim'), true);
    assert.strictEqual(specRequests, requestsBeforeExpiry + 3, 'Destructive expiry checks must bypass an older positive cache entry');
    await backupService.testHooks.checkExpiredApps();
    assert.deepStrictEqual(removed, ['victim-backup']);
    assert.deepStrictEqual(softRemovals, [42]);
    assert(updates.length > 0, 'Confirmed ownership still updates app expiry normally');

    assert.throws(() => registry.testHooks.parseBackendPool('# pxname,svname,status\napirunonfluxiobackend,server1_203.0.113.11,UP\napirunonfluxiobackend,server2_203.0.113.11,UP\napirunonfluxiobackend,server3_203.0.113.11,UP'));
    assert.throws(() => registry.testHooks.parseBackendPool('<html>A FluxOS backend cannot nominate peers</html>'));
    registry.testHooks.clearCaches();
    discoveryFailure = true;
    assert.strictEqual(await fluxOS.getAppSpecs('victim'), false);
    assert(!requests.some((url) => url.startsWith('http:')), 'Registry and gateway traffic must never use plaintext HTTP');
  } finally {
    axios.get = originalGet;
    Vault.getKey = originalGetKey;
    fluxDrive.removeFileVerified = originalRemove;
    Object.assign(log, originalLogs);
    backupService.testHooks.setDatabaseForTests(originalDatabase);
    registry.testHooks.clearCaches();
  }
  console.log('Independent registry confirmation security tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
