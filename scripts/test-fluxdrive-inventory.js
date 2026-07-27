const assert = require('assert');
const fluxDrive = require('../src/services/fluxDrive');

function hashesFrom(response) {
  const inventory = fluxDrive.parseFileInventory(response);
  assert.strictEqual(inventory.success, true);
  return [...inventory.hashes].sort();
}

assert.deepStrictEqual(
  hashesFrom({ status: 'success', files: [{ hash: 'hash-a' }, { cid: 'hash-b' }] }),
  ['hash-a', 'hash-b'],
);

assert.deepStrictEqual(
  hashesFrom({ status: 'success', data: { files: [{ Hash: 'hash-c' }] } }),
  ['hash-c'],
);

assert.deepStrictEqual(
  hashesFrom({ status: 'success', result: { entries: ['hash-d'] } }),
  ['hash-d'],
);

assert.deepStrictEqual(hashesFrom({ status: 'success', files: [] }), []);

assert.strictEqual(
  fluxDrive.parseFileInventory({ status: 'error', message: 'unavailable' }).success,
  false,
);

assert.strictEqual(
  fluxDrive.parseFileInventory({ status: 'success', files: [{ name: 'unknown' }] }).success,
  false,
);

assert.strictEqual(
  fluxDrive.parseFileInventory({ status: 'success', unexpected: [] }).success,
  false,
);

assert.strictEqual(
  fluxDrive.parseFileInventory({
    status: 'success',
    files: [{ hash: 'hash-e' }],
    hasMore: true,
  }).success,
  false,
);

console.log('FluxDrive inventory parser tests passed');
