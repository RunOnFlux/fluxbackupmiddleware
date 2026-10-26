/* eslint-disable no-await-in-loop, no-restricted-syntax */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const qs = require('qs');
const config = require('../config/default');
const fluxOS = require('../src/services/fluxOsService');
const fileService = require('../src/services/fileService');
const backupService = require('../src/services/backupService');
const Vault = require('../src/services/Vault');
const log = require('../src/lib/log');
const wallet = require('../src/services/utils/bitcoinMessage');
const policy = require('../src/services/utils/nodeAuthentication');

function identity(number) {
  const key = Buffer.alloc(32);
  key[31] = number;
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(key);
  return { key: key.toString('hex'), zelid: wallet.publicKeyToAddress(ecdh.getPublicKey(null, 'compressed')) };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => { server.close(resolve); });
}

async function main() {
  const primary = identity(1);
  const secondary = identity(2);
  const owner = identity(3);
  const settings = { ...config };
  const originalGetKey = Vault.getKey;
  const originalLogs = { info: log.info, warn: log.warn, error: log.error };
  const originalDatabase = backupService.getDatabase();
  const credentials = {
    teamFluxID: primary.zelid, teamPK: primary.key, teamFluxID2: secondary.zelid, teamPK2: secondary.key,
  };
  const signedRequests = [];
  const receivedHeaders = [];
  let nodeRequests = 0;
  let otherRequests = 0;
  let phrase = 'not a numeric login phrase'.padEnd(40, '.');
  let redirectChallenge = false;
  let redirectLogin = false;
  let rejectPrimary = false;
  let otherOrigin;
  const receiver = http.createServer((req, res) => {
    otherRequests += 1;
    receivedHeaders.push(req.headers.zelidauth);
    res.end('unexpected cross-origin request');
  });
  const node = http.createServer((req, res) => {
    nodeRequests += 1;
    if (req.url === '/id/loginphrase') {
      if (redirectChallenge) {
        res.writeHead(302, { location: `${otherOrigin}/challenge` });
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ status: 'success', data: phrase }));
    }
    if (req.url === '/id/verifylogin') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const auth = qs.parse(body);
        signedRequests.push(auth);
        assert(policy.isValidNodeLoginPhrase(auth.loginPhrase));
        assert(wallet.verify(auth.loginPhrase, auth.zelid, auth.signature));
        if (redirectLogin) {
          res.writeHead(307, { location: `${otherOrigin}/login` });
          res.end();
          return;
        }
        const refused = rejectPrimary && auth.zelid === primary.zelid;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: refused ? 'error' : 'success', data: { message: refused ? 'Unauthorized' : 'OK' } }));
      });
      return undefined;
    }
    receivedHeaders.push(req.headers.zelidauth);
    if (req.url === '/same-origin') {
      res.writeHead(302, { location: '/archive' });
      return res.end();
    }
    if (req.url === '/archive') return res.end('archive-data');
    res.writeHead(302, { location: `${otherOrigin}/steal` });
    return res.end();
  });
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-auth-test-'));
  try {
    const origin = await listen(node);
    otherOrigin = await listen(receiver);
    config.storagePath = storageRoot;
    config.storageMinimumFreeGb = 0;
    Vault.getKey = async (name) => credentials[name] || null;
    ['info', 'warn', 'error'].forEach((level) => { log[level] = () => {}; });

    // No node may turn its login challenge into a signing oracle for either key.
    assert.strictEqual((await fluxOS.verifyTeamLoginDetailed(origin)).zelidAuth, null);
    assert.strictEqual((await fluxOS.verifyLoginDetailed(primary.zelid, primary.key, origin)).zelidAuth, null);
    const creation = await fluxOS.createBackupTaskWithTeamCredentials(origin, 'test-app', ['app']);
    assert.strictEqual(creation.status, 'failed');
    assert.strictEqual(signedRequests.length, 0);

    const arbitraryMessage = `fluxappupdate1${JSON.stringify({ name: 'test1790000000000', owner: owner.zelid })}${Date.now()}`;
    for (const invalid of [arbitraryMessage, 'n'.repeat(40), '123456789012x'.padEnd(40, 'a'),
      `${Date.now() - 16 * 60 * 1000}${'a'.repeat(40)}`, `${Date.now() + 60000}${'a'.repeat(40)}`,
      `${Date.now()}${'a'.repeat(58)}`, `${Date.now()}${'a'.repeat(26)}`, {}, ['not-a-phrase']]) {
      phrase = invalid;
      assert.strictEqual((await fluxOS.verifyTeamLoginDetailed(origin)).zelidAuth, null);
    }
    assert.strictEqual(signedRequests.length, 0, 'Neither team identity may sign arbitrary or malformed messages');

    phrase = `${Date.now()}${'a'.repeat(40)}`;
    rejectPrimary = true;
    const valid = await fluxOS.verifyTeamLoginDetailed(origin);
    assert.strictEqual(valid.credential, 'secondary');
    assert.deepStrictEqual(signedRequests.map((auth) => auth.zelid), [primary.zelid, secondary.zelid]);
    rejectPrimary = false;
    redirectChallenge = true;
    assert.strictEqual((await fluxOS.verifyTeamLoginDetailed(origin)).zelidAuth, null);
    redirectChallenge = false;
    redirectLogin = true;
    assert.strictEqual((await fluxOS.verifyTeamLoginDetailed(origin)).zelidAuth, null);
    redirectLogin = false;
    assert.strictEqual(otherRequests, 0, 'Login requests and signatures must not follow redirects');

    // Manual task registration and downloads use the real requester's signature, never a team login.
    const loginPhrase = `${Date.now()}${'a'.repeat(40)}`;
    const ownerAuth = qs.stringify({
      zelid: owner.zelid, loginPhrase, signature: wallet.sign(loginPhrase, Buffer.from(owner.key, 'hex'), true).toString('base64'),
    });
    const task = {
      taskId: 701,
      owner: owner.zelid,
      appname: 'test-app',
      component: 'app',
      timestamp: Date.now(),
      filename: 'backup.tar.gz',
      filesize: 12,
      host: `${origin}/same-origin`,
      backup_type: 'manual',
      extra: ownerAuth,
    };
    config.maxConcurrentTasks = 0;
    const originalOwner = fluxOS.verifyAppOwner;
    const originalExpire = fluxOS.getAppExpireHeight;
    let registered;
    backupService.testHooks.setDatabaseForTests({
      execute: async () => [], addNewTask: async (value) => { registered = value; return { insertId: task.taskId }; },
    });
    try {
      fluxOS.verifyAppOwner = async (identityValue) => identityValue === owner.zelid;
      fluxOS.getAppExpireHeight = async () => 9999999;
      let result;
      await backupService.registerBackupTask({ body: task, query: {}, headers: { zelidauth: ownerAuth } }, { json: (value) => { result = value; } });
      assert.strictEqual(result.status, 'success');
      assert.strictEqual(registered.extra, ownerAuth);
    } finally {
      fluxOS.verifyAppOwner = originalOwner;
      fluxOS.getAppExpireHeight = originalExpire;
    }
    const signaturesBeforeDownload = signedRequests.length;
    await fileService.downloadFileFromHost(task);
    assert(receivedHeaders.includes(ownerAuth));
    assert.strictEqual(signedRequests.length, signaturesBeforeDownload);
    await assert.rejects(fileService.downloadFileFromHost({ ...task, taskId: 702, host: `${origin}/cross-origin` }), (error) => error.code === 'BACKUP_REDIRECT_BLOCKED');
    assert.strictEqual(otherRequests, 0, 'A redirect target must never receive the owner or team credential');
    const forged = {
      ...task, taskId: 703, extra: '', backup_type: 'automatic',
    };
    const requestsBefore = nodeRequests;
    await fileService.downloadFileFromHost(forged);
    assert(nodeRequests > requestsBefore);
    await assert.rejects(fileService.getTaskRequestAuthentication({ ...task, extra: '' }), (error) => error.code === 'BACKUP_OWNER_AUTH_REQUIRED');
    await assert.rejects(fileService.getTaskRequestAuthentication({ ...task, owner: primary.zelid }), (error) => error.code === 'BACKUP_OWNER_AUTH_REQUIRED');
    // An alternate public-key spelling must not disguise a global team identity.
    const teamPublicKey = crypto.createECDH('secp256k1');
    teamPublicKey.setPrivateKey(Buffer.from(primary.key, 'hex'));
    const alternateTeamIdentity = teamPublicKey.getPublicKey('hex', 'compressed');
    const teamAuth = qs.stringify({
      zelid: alternateTeamIdentity,
      loginPhrase,
      signature: wallet.sign(loginPhrase, Buffer.from(primary.key, 'hex'), true).toString('base64'),
    });
    assert.strictEqual((await fileService.getTaskRequestAuthentication({
      ...task, owner: alternateTeamIdentity, extra: teamAuth,
    })).zelidauth, teamAuth);
    const diagnostic = { ...task, extra: JSON.stringify({ auth: ownerAuth, failureDiagnostic: { detail: 'retry' } }) };
    assert.strictEqual((await fileService.getTaskRequestAuthentication(diagnostic)).zelidauth, ownerAuth);

    await fileService.downloadFileFromHost({
      ...task, taskId: 704, backup_type: 'automatic', extra: '', host: `${origin}/archive`,
    });
    assert(receivedHeaders.some((header) => qs.parse(header || '').zelid === primary.zelid));
    await assert.rejects(fluxOS.testHooks.listVolumeFolder(origin, valid.zelidAuth, 'test-app', 'app', 'appdata'));
    assert.strictEqual(await backupService.testHooks.removeBackupFromRemoteHost({ ...task, host: `${origin}/backup/downloadlocalfile/file/test-app` }, task.taskId), false);
    assert.strictEqual(otherRequests, 0, 'Volume operations and cleanup must not follow redirects');

    const fluxHttps = 'https://185-209-30-228-16127.node.api.runonflux.io';
    assert.strictEqual(policy.fluxHttpsOrigin('http://185.209.30.228:16127'), fluxHttps);
    assert.strictEqual(policy.fluxHttpsOrigin(fluxHttps), fluxHttps);
    assert.strictEqual(policy.authenticatedNodeOrigin('http://185.209.30.228:16127'), fluxHttps);
    assert.strictEqual(policy.authenticatedNodeOrigin(fluxHttps), fluxHttps);
    assert.strictEqual(policy.authenticatedNodeUrl('http://185.209.30.228:16127/backup/file?q=1').href, `${fluxHttps}/backup/file?q=1`);
    assert.strictEqual(policy.authenticatedNodeUrl('http://185.209.30.228:16127//attacker.example/steal').origin, fluxHttps);
    assert.strictEqual(policy.isValidNodeLoginPhrase(`${Date.now()}${'a'.repeat(40)}\n`), false);
    for (const url of ['file:///etc/passwd', 'ftp://node.example', 'https://user:password@node.example', 'https://node.example/#fragment']) {
      assert.throws(() => policy.parseHttpUrl(url));
    }
    assert.throws(() => policy.authenticatedNodeOrigin('http://community.example:16127'));
  } finally {
    Object.assign(config, settings);
    Vault.getKey = originalGetKey;
    Object.assign(log, originalLogs);
    backupService.testHooks.setDatabaseForTests(originalDatabase);
    await Promise.all([close(node), close(receiver)]);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
  console.log('Outbound node authentication security tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
