const assert = require('assert');
const bs58check = require('bs58check');
const bitcoinMessage = require('../src/services/utils/bitcoinMessage');
const { verifySignature } = require('../src/services/utils/signatureVerifier');
const { testHooks } = require('../src/services/fluxOsService');
const log = require('../src/lib/log');
const fixture = require('./fixtures/wallet-compatibility');

// Captured with bitcoinjs-message 2.2.0 and zeltrezjs 2.12.0 before removal.
// Key 1 is a public test key; these vectors contain no production credentials.
const privateKey = Buffer.from(fixture.privateKey, 'hex');
const originalError = log.error;
log.error = () => {};
try {
  fixture.vectors.forEach((vector) => {
    const prefix = vector.prefix || undefined;
    assert.strictEqual(bitcoinMessage.verify(vector.message, vector.address, vector.signature, prefix), true);
    assert.strictEqual(bitcoinMessage.verify(`${vector.message}!`, vector.address, vector.signature, prefix), false);
    assert.strictEqual(bitcoinMessage.verify(vector.message, vector.address, vector.signature, `${prefix || ''}wrong`), false);
    if (Buffer.from(vector.signature, 'base64')[0] <= 34) {
      assert.strictEqual(bitcoinMessage.publicKeyToAddress(vector.publicKey), vector.address);
      assert.strictEqual(bitcoinMessage.sign(vector.message, privateKey, vector.compressed, prefix).toString('base64'), vector.signature);
      if (!vector.prefix) {
        assert.strictEqual(verifySignature(vector.message, vector.address, vector.signature), true);
        assert.strictEqual(verifySignature(vector.message, vector.publicKey, vector.signature), true);
      }
      if (vector.compressed) {
        [fixture.privateKey, fixture.wifCompressed, fixture.wifUncompressed].forEach((key) => {
          assert.strictEqual(testHooks.signMessage(vector.message, key, prefix), vector.signature);
        });
      }
    }
  });
  [fixture.privateKey, fixture.wifCompressed, fixture.wifUncompressed].forEach((key) => {
    assert.deepStrictEqual(bitcoinMessage.privateKeyFromString(key), privateKey);
  });
  const invalidMarker = bs58check.encode(Buffer.concat([Buffer.from([0x80]), privateKey, Buffer.from([2])]));
  const truncatedKey = bs58check.encode(Buffer.concat([Buffer.from([0x80]), privateKey.subarray(1)]));
  [undefined, null, '', '0'.repeat(64), 'g'.repeat(64), 'f'.repeat(64), invalidMarker, truncatedKey,
    `${fixture.wifCompressed.slice(0, -1)}!`].forEach((key) => {
    assert.throws(() => bitcoinMessage.privateKeyFromString(key));
  });
  const vector = fixture.vectors[0];
  [null, '', 'invalid', Buffer.alloc(65), Buffer.concat([Buffer.from([43]), Buffer.alloc(64)])].forEach((signature) => {
    assert.strictEqual(verifySignature(vector.message, vector.address, signature), false);
  });
} finally {
  log.error = originalError;
}
console.log(`Wallet compatibility tests passed (${fixture.vectors.length} independent signature vectors)`);
