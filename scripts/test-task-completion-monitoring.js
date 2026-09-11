const assert = require('assert');

const { testHooks } = require('../src/services/backupService');

const progressStates = ['in queue', 'started', 'downloading', 'uploading', 'waiting'];
progressStates.forEach((state) => {
  const task = {
    finishTime: '0',
    uploaded: 0,
    fails: 1,
    status: { state, message: state === 'started' ? 'backup to FluxDrive started' : state },
  };
  assert.deepStrictEqual(testHooks.getTaskOutcome(task), { state: 'pending' });
});

assert.deepStrictEqual(
  testHooks.getTaskOutcome({
    finishTime: 123,
    uploaded: 1,
    fails: 0,
    status: { state: 'finished', message: 'finished' },
  }),
  { state: 'success' },
);

assert.deepStrictEqual(
  testHooks.getTaskOutcome({
    finishTime: 123,
    uploaded: 0,
    fails: 1,
    status: { state: 'started', message: 'backup to FluxDrive started' },
  }),
  { state: 'failed', reason: 'Task ended before the FluxDrive upload completed' },
);

const terminalFailure = testHooks.getTaskOutcome({
  finishTime: 0,
  uploaded: 0,
  fails: 4,
  status: { state: 'failed', message: 'connect ETIMEDOUT 192.0.2.1:16127' },
});
assert.strictEqual(terminalFailure.state, 'failed');
assert.strictEqual(terminalFailure.reason, 'connect ETIMEDOUT 192.0.2.1:16127');

const diagnostic = testHooks.buildTaskFailure({
  component: 'palworld',
  fails: 1,
  status: { state: 'started', message: 'backup to FluxDrive started' },
  host: 'http://192.0.2.1:16127/backup/downloadlocalfile/file/app',
}, 7859, 'Timeout waiting for tasks to complete after 60 minutes');
assert.strictEqual(diagnostic.message, 'Timeout waiting for tasks to complete after 60 minutes');

console.log('Task completion monitoring tests passed');
