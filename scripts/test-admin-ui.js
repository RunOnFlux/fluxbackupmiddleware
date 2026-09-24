const assert = require('assert');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const bitcoinMessage = require('bitcoinjs-message');
const ethereumSigner = require('nano-ethereum-signer');

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
const appNames = Array.from({ length: 30 }, (_, index) => `app${String(index + 1).padStart(2, '0')}`);
const appQueries = [];
const nowSeconds = Math.floor(Date.now() / 1000);
backupService.getDatabase = () => ({
  execute: async (sql, params = []) => {
    if (sql.includes('SUM(finishTime')) {
      assert(params.every((time) => time < 10000000000));
      return [{
        running: 2, completed7d: 7, storedBytes: 4096, addedBytes7d: 1024,
      }];
    }
    if (sql.includes('newMarketplace7d')) {
      assert(params[0] > 1000000000000);
      return [{ total: 3, marketplace: 2, newMarketplace7d: 1 }];
    }
    if (sql.includes('FLOOR(finishTime')) {
      assert(sql.includes('finishTime / 86400'));
      return [{ day: Math.floor(nowSeconds / 86400), count: 7 }];
    }
    if (sql.includes('FROM tasks ORDER BY taskId DESC LIMIT 8')) {
      return [{
        taskId: 42,
        appname: 'sampleapp',
        component: 'app',
        filesize: 1024,
        finishTime: nowSeconds,
        uploaded: 1,
        fails: 0,
        status: '{}',
      }];
    }
    if (sql.includes('FROM automatic_backups WHERE (status')) {
      appQueries.push({ sql, params });
      assert(sql.includes('LIMIT 26'));
      const names = [...appNames, 'sampleapp'];
      return names.filter((name) => name.startsWith(params[0].replace('%', '')) && name > params[1])
        .slice(0, 26).map((name) => ({
          appname: name, is_marketplace: 1, status: 'active', last_backup_timestamp: Date.now(),
        }));
    }
    if (sql.includes('SELECT DISTINCT t.appname')) {
      appQueries.push({ sql, params });
      assert(sql.includes('LIMIT 26'));
      return ['app15m'].filter((name) => name.startsWith(params[0].replace('%', '')) && name > params[1])
        .map((name) => ({ appname: name }));
    }
    if (sql.includes('SELECT appname, COUNT(*) AS files')) {
      return params.map((appname) => ({
        appname, files: 1, bytes: 1024, last_finished: nowSeconds,
      }));
    }
    if (sql.includes('COUNT(*) AS total FROM tasks')) return [{ total: 1 }];
    if (sql.includes('SELECT taskId, timestamp')) {
      return [{
        taskId: 42, timestamp: nowSeconds, component: 'app', filesize: 1024, hash: 'Qm123abc', finishTime: nowSeconds,
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
  const post = (path, body, cookie, origin = base.replace('http:', 'https:')) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  try {
    assert.strictEqual((await get('/admin/api/dashboard')).status, 401);
    const bareAdmin = await get('/admin');
    assert.strictEqual(bareAdmin.status, 302);
    assert.strictEqual(bareAdmin.headers.get('location'), '/admin/login.html');
    const slashAdmin = await get('/admin/');
    assert.strictEqual(slashAdmin.status, 302);
    assert.strictEqual(slashAdmin.headers.get('location'), '/admin/login.html');
    assert.strictEqual((await post('/admin/api/challenge', {}, null, base)).status, 403);
    const challenge = await (await post('/admin/api/challenge', {})).json();
    assert(challenge.message.includes(challenge.id));
    const signature = bitcoinMessage.sign(challenge.message, privateKey, true).toString('base64');
    assert.strictEqual((await post('/admin/api/login', { id: challenge.id, address, signature }, null, 'https://evil.example')).status, 403);
    assert.strictEqual((await post('/admin/api/login', { id: challenge.id, address, signature }, null, base)).status, 403);
    const login = await post('/admin/api/login', { id: challenge.id, address, signature });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert(login.headers.get('set-cookie').includes('HttpOnly'));
    assert(login.headers.get('set-cookie').includes('Secure'));
    assert(login.headers.get('set-cookie').includes('SameSite=Strict'));
    assert.strictEqual((await post('/admin/api/login', { id: challenge.id, address, signature })).status, 401);
    const dashboard = await (await get('/admin/api/dashboard', cookie)).json();
    assert.strictEqual(dashboard.recent[0].time, nowSeconds * 1000);
    assert.strictEqual(dashboard.daily[0].day, Math.floor(nowSeconds / 86400));
    assert.strictEqual((await get('/admin', cookie)).status, 200);
    assert.strictEqual((await get('/admin/', cookie)).status, 200);
    const apps = await (await get('/admin/api/apps?q=sample&category=marketplace', cookie)).json();
    assert.strictEqual(apps.rows[0].name, 'sampleapp');
    const appFirst = await (await get('/admin/api/apps?q=app&category=all&page=0', cookie)).json();
    assert.strictEqual(appFirst.rows.length, 25);
    assert.strictEqual(appFirst.hasMore, true);
    assert(appFirst.nextCursor);
    const appSecond = await (await get(`/admin/api/apps?q=app&category=all&page=1&cursor=${encodeURIComponent(appFirst.nextCursor)}`, cookie)).json();
    assert.strictEqual(appSecond.rows.length, 6);
    assert.strictEqual(appSecond.hasMore, false);
    assert.strictEqual(new Set([...appFirst.rows, ...appSecond.rows].map((row) => row.name)).size, 31);
    assert.strictEqual([...appFirst.rows, ...appSecond.rows].find((row) => row.name === 'app15m').lastBackup, nowSeconds * 1000);
    assert(appQueries.every(({ params }) => params.length === 2));
    assert.strictEqual((await get('/admin/api/apps?cursor=bad', cookie)).status, 400);
    const backups = await (await get('/admin/api/backups?appname=sampleapp', cookie)).json();
    assert.strictEqual(backups.rows[0].bytes, 1024);
    assert.strictEqual(backups.rows[0].checkpoint, nowSeconds * 1000);
    assert.strictEqual(backups.rows[0].time, nowSeconds * 1000);
    assert(backups.rows[0].url.endsWith('/Qm123abc'));
    const walletChallenge = await (await post('/admin/api/challenge', {})).json();
    const walletSignature = bitcoinMessage.sign(walletChallenge.message, privateKey, true).toString('base64');
    assert.strictEqual((await post('/admin/api/wallet-callback', { message: walletChallenge.message, signature: walletSignature })).status, 200);
    assert.strictEqual((await post('/admin/api/wallet-status', { id: walletChallenge.id, pollToken: 'bad' })).status, 401);
    assert.strictEqual((await post('/admin/api/wallet-status', { id: walletChallenge.id, pollToken: walletChallenge.pollToken }, null, base)).status, 403);
    const redeemed = await post('/admin/api/wallet-status', { id: walletChallenge.id, pollToken: walletChallenge.pollToken });
    assert.strictEqual(redeemed.status, 200);
    assert(redeemed.headers.get('set-cookie').includes('HttpOnly'));
    assert.strictEqual((await post('/admin/api/wallet-status', { id: walletChallenge.id, pollToken: walletChallenge.pollToken })).status, 401);
    const ethereumChallenge = await (await post('/admin/api/challenge', {})).json();
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
