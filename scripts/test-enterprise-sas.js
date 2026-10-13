const assert = require('assert');
const crypto = require('crypto');
const enterpriseCrypto = require('../src/services/enterpriseCrypto');

function buildEnterpriseSpec(content, overrides = {}) {
  const aesKey = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(content), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const encryptedAesKey = crypto.randomBytes(256);
  return {
    aesKey,
    encryptedAesKey,
    spec: {
      name: 'enterprise-test-app',
      owner: 'test-owner',
      version: 8,
      hash: 'enterprise-test-hash',
      enterprise: Buffer.concat([
        encryptedAesKey,
        nonce,
        ciphertext,
        authTag,
      ]).toString('base64'),
      ...overrides,
    },
  };
}

function makeRuntime(overrides = {}) {
  return {
    sasConfig: {
      timeoutMs: 100,
      retryAttempts: 4,
      retryDelayMs: 1,
      ...overrides,
    },
    httpsAgent: { test: true },
    decryptUrl: 'https://sas.example.test/decryptMessageRSA',
  };
}

async function main() {
  enterpriseCrypto.clearCaches();
  const fixture = buildEnterpriseSpec({
    compose: JSON.stringify([{
      name: 'server',
      repotag: 'example/server:latest',
      containerData: 's:/data',
    }]),
    contacts: ['test@example.com'],
  });
  let sasCalls = 0;
  const axiosClient = {
    async post(url, payload, requestConfig) {
      sasCalls += 1;
      assert.strictEqual(url, 'https://sas.example.test/decryptMessageRSA');
      assert.strictEqual(payload.fluxID, fixture.spec.owner);
      assert.strictEqual(payload.appName, fixture.spec.name);
      assert.strictEqual(payload.blockHeight, 9999999);
      assert.strictEqual(payload.message, fixture.encryptedAesKey.toString('base64'));
      assert.strictEqual(requestConfig.timeout, 100);
      return {
        status: 200,
        data: { status: 'ok', message: fixture.aesKey.toString('base64') },
      };
    },
  };

  const decrypted = await enterpriseCrypto.decryptEnterpriseSpecWithSas(fixture.spec, {
    runtime: makeRuntime(),
    axiosClient,
  });
  assert(Array.isArray(decrypted.compose));
  assert.strictEqual(decrypted.compose[0].containerData, 's:/data');
  assert.deepStrictEqual(decrypted.contacts, ['test@example.com']);
  assert.strictEqual(sasCalls, 1);

  const cached = await enterpriseCrypto.decryptEnterpriseSpecWithSas(fixture.spec, {
    runtime: makeRuntime(),
    axiosClient: { post: async () => { throw new Error('cache miss'); } },
  });
  assert.deepStrictEqual(cached, decrypted);
  assert.strictEqual(sasCalls, 1);

  enterpriseCrypto.clearCaches();
  let transientCalls = 0;
  let delays = 0;
  const transientResult = await enterpriseCrypto.decryptAesKeyViaSas(
    fixture.spec.name,
    fixture.spec.owner,
    fixture.encryptedAesKey,
    {
      runtime: makeRuntime(),
      axiosClient: {
        async post() {
          transientCalls += 1;
          if (transientCalls < 3) throw new Error('connect ETIMEDOUT');
          return {
            status: 200,
            data: { status: 'ok', message: fixture.aesKey.toString('base64') },
          };
        },
      },
      delay: async () => { delays += 1; },
    },
  );
  assert.strictEqual(transientResult, fixture.aesKey.toString('base64'));
  assert.strictEqual(transientCalls, 3);
  assert.strictEqual(delays, 2);

  let rejectionCalls = 0;
  await assert.rejects(
    enterpriseCrypto.decryptAesKeyViaSas(
      fixture.spec.name,
      fixture.spec.owner,
      fixture.encryptedAesKey,
      {
        runtime: makeRuntime(),
        axiosClient: {
          async post() {
            rejectionCalls += 1;
            return { status: 200, data: { status: 'denied' } };
          },
        },
        delay: async () => { throw new Error('must not retry rejection'); },
      },
    ),
    /SAS rejected enterprise decryption/,
  );
  assert.strictEqual(rejectionCalls, 1);

  enterpriseCrypto.clearCaches();
  await assert.rejects(
    enterpriseCrypto.decryptEnterpriseSpecWithSas({
      name: 'short-enterprise-app',
      owner: 'test-owner',
      version: 8,
      enterprise: Buffer.alloc(20).toString('base64'),
    }, { runtime: makeRuntime(), axiosClient }),
    /is too short/,
  );

  console.log('enterprise SAS decryption tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
