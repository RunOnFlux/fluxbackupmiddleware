const assert = require('assert');
const {
  extractReconciledTasks,
  isRecoverableTask,
} = require('../src/services/utils/reconciliationRecovery');

const extracted = extractReconciledTasks(`
2026-07-29T22:53:44.905Z Reconciled task 4379: hash QmHashA was absent from two consecutive FluxDrive inventories
unrelated log line
2026-07-29T22:53:45.905Z Reconciled task 4380: hash QmHashB was absent from two consecutive FluxDrive inventories
`);
assert.deepStrictEqual([...extracted.entries()], [[4379, 'QmHashA'], [4380, 'QmHashB']]);

const recoverable = {
  uploaded: 0,
  removedFromFluxdrive: 1,
  reconciliationRecovered: 0,
  hash: 'QmHashA',
  status: '{"state":"finished","message":"finished","progress":100}',
};
assert.strictEqual(isRecoverableTask(recoverable, 'QmHashA'), true);
assert.strictEqual(isRecoverableTask({ ...recoverable, uploaded: 1 }, 'QmHashA'), false);
assert.strictEqual(isRecoverableTask({ ...recoverable, reconciliationRecovered: 1 }, 'QmHashA'), false);
assert.strictEqual(isRecoverableTask(recoverable, 'QmOther'), false);
assert.strictEqual(
  isRecoverableTask({ ...recoverable, status: '{"state":"failed"}' }, 'QmHashA'),
  false,
);

console.log('Reconciliation recovery tests passed');
