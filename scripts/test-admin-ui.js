const assert = require('assert');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const bitcoinMessage = require('bitcoinjs-message');
const ethereumSigner = require('nano-ethereum-signer');

process.env.ADMIN_COOKIE_SECURE = 'false';
const secrets = require('../secrets');
const backupService = require('../src/services/backupService');
const ethereumHelper = require('../src/services/utils/ethereumHelper');

const originalAddresses = secrets.adminAddresses;
const originalDatabase = backupService.getDatabase;
const originalOpen = fs.promises.open;
const privateKey = crypto.randomBytes(32);
const ecdh = crypto.createECDH('secp256k1');
ecdh.setPrivateKey(privateKey);
const publicKey = ecdh.getPublicKey(null, 'compressed');
const publicHash = crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(publicKey).digest()).digest();
const payload = Buffer.concat([Buffer.from([0]), publicHash]);
const checksum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
const addressBytes = Buffer.concat([payload, checksum]);
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let value = global.BigInt(`0x${addressBytes.toString('hex')}`);
let address = '';
while (value > 0n) {
  address = alphabet[Number(value % 58n)] + address;
  value /= 58n;
}
for (let index = 0; index < addressBytes.length && addressBytes[index] === 0; index += 1) {
  address = `1${address}`;
}
const ethereumPrivateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ethereumAddress = ethereumSigner.addressFromKey(ethereumPrivateKey);
secrets.adminAddresses = [address, ethereumAddress];
backupService.getDatabase = () => ({
  execute: async (sql) => {
    if (sql.includes('SUM(finishTime')) {
      return [{
        running: 2, completed7d: 7, storedBytes: 4096, addedBytes7d: 1024,
      }];
    }
    if (sql.includes('newMarketplace7d')) return [{ total: 3, marketplace: 2, newMarketplace7d: 1 }];
    if (sql.includes('COUNT(*) AS total FROM (SELECT appname')) return [{ total: 1 }];
    if (sql.includes('SELECT names.appname')) {
      return [{
        appname: 'sampleapp', is_marketplace: 1, status: 'active', last_backup_timestamp: Date.now(), files: 1, bytes: 1024,
      }];
    }
    if (sql.includes('COUNT(*) AS total FROM tasks')) return [{ total: 1 }];
    if (sql.includes('SELECT taskId, timestamp')) {
      return [{
        taskId: 42, timestamp: Date.now(), component: 'app', filesize: 1024, hash: 'Qm123abc', finishTime: Date.now(),
      }];
    }
    return [];
  },
});
const app = require('../src/lib/server');

const lines = Array.from({ length: 120 }, (_, index) => `2026-09-24 line ${index}${index % 2 ? ' match' : ''}`);
const content = Buffer.from(`${lines.join('\n')}\n`);
fs.promises.open = async (file, mode) => {
  if (!file.endsWith('/logs/debug.log')) return originalOpen(file, mode);
  return {
    stat: async () => ({ size: content.length }),
    read: async (buffer, offset, length, position) => {
      const bytesRead = content.copy(buffer, offset, position, position + length);
      return { bytesRead };
    },
    close: async () => {},
  };
};

async function run() {
  const server = http.createServer(app);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const post = (path, body, cookie, origin = base) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  try {
    assert.strictEqual((await get('/admin/api/dashboard')).status, 401);
    assert.strictEqual((await get('/admin/')).status, 302);
    const challenge = await (await get('/admin/api/challenge')).json();
    assert(challenge.message.includes(challenge.id));
    const signature = bitcoinMessage.sign(challenge.message, privateKey, true).toString('base64');
    assert.strictEqual((await post('/admin/api/login', { id: challenge.id, address, signature }, null, 'https://evil.example')).status, 403);
    const login = await post('/admin/api/login', { id: challenge.id, address, signature });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert(login.headers.get('set-cookie').includes('HttpOnly'));
    assert(login.headers.get('set-cookie').includes('SameSite=Strict'));
    assert.strictEqual((await post('/admin/api/login', { id: challenge.id, address, signature })).status, 401);
    assert.strictEqual((await get('/admin/api/dashboard', cookie)).status, 200);
    const apps = await (await get('/admin/api/apps?q=sample&category=marketplace', cookie)).json();
    assert.strictEqual(apps.rows[0].name, 'sampleapp');
    const backups = await (await get('/admin/api/backups?appname=sampleapp', cookie)).json();
    assert.strictEqual(backups.rows[0].bytes, 1024);
    assert(backups.rows[0].url.endsWith('/Qm123abc'));
    const walletChallenge = await (await get('/admin/api/challenge')).json();
    const walletSignature = bitcoinMessage.sign(walletChallenge.message, privateKey, true).toString('base64');
    assert.strictEqual((await post('/admin/api/wallet-callback', { message: walletChallenge.message, signature: walletSignature })).status, 200);
    assert.strictEqual((await get(`/admin/api/wallet-status?id=${walletChallenge.id}&pollToken=bad`)).status, 401);
    const redeemed = await get(`/admin/api/wallet-status?id=${walletChallenge.id}&pollToken=${walletChallenge.pollToken}`);
    assert.strictEqual(redeemed.status, 200);
    assert(redeemed.headers.get('set-cookie').includes('HttpOnly'));
    assert.strictEqual((await get(`/admin/api/wallet-status?id=${walletChallenge.id}&pollToken=${walletChallenge.pollToken}`)).status, 401);
    const ethereumChallenge = await (await get('/admin/api/challenge')).json();
    const ethereumSignature = ethereumSigner.signMessage(ethereumHelper.hashMessage(ethereumChallenge.message), ethereumPrivateKey);
    assert.strictEqual((await post('/admin/api/login', {
      id: ethereumChallenge.id, address: ethereumAddress.toLowerCase(), signature: ethereumSignature,
    })).status, 200);
    const first = await (await get('/admin/api/logs?type=debug', cookie)).json();
    assert.strictEqual(first.rows.length, 50);
    const second = await (await get(`/admin/api/logs?type=debug&cursor=${first.nextCursor}`, cookie)).json();
    assert.strictEqual(second.rows.length, 50);
    assert.notStrictEqual(first.rows[49], second.rows[0]);
    const matches = await (await get('/admin/api/logs?type=debug&q=match', cookie)).json();
    assert(matches.rows.every((line) => line.includes('match')));
    assert.strictEqual((await post('/admin/api/logout', {}, cookie)).status, 200);
    assert.strictEqual((await get('/admin/api/dashboard', cookie)).status, 401);
    console.log('Admin UI auth and pagination tests passed');
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
    secrets.adminAddresses = originalAddresses;
    backupService.getDatabase = originalDatabase;
    fs.promises.open = originalOpen;
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
