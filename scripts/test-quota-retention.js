const assert = require('assert');
const {
  groupBackupTasksByAge,
  planBackupPruning,
} = require('../src/services/utils/quotaRetention');

const tasks = [
  {
    taskId: 4, appname: 'app-b', timestamp: 200, filesize: 40,
  },
  {
    taskId: 2, appname: 'app-a', timestamp: 100, filesize: 20,
  },
  {
    taskId: 3, appname: 'app-b', timestamp: 200, filesize: 30,
  },
  {
    taskId: 1, appname: 'app-a', timestamp: 100, filesize: 10,
  },
  {
    taskId: 5, appname: 'app-a', timestamp: 300, filesize: 50,
  },
];

const batches = groupBackupTasksByAge(tasks);
assert.deepStrictEqual(
  batches.map((batch) => [batch.appname, Number(batch.timestamp), batch.totalBytes]),
  [['app-a', 100, 30], ['app-b', 200, 70], ['app-a', 300, 50]],
);

const plan = planBackupPruning(tasks, 80);
assert.strictEqual(plan.canReclaim, true);
assert.strictEqual(plan.selectedBytes, 100);
assert.deepStrictEqual(plan.batches.map((batch) => batch.timestamp), [100, 200]);
assert.strictEqual(plan.batches[0].tasks.length, 2);

const impossiblePlan = planBackupPruning(tasks, 151);
assert.strictEqual(impossiblePlan.canReclaim, false);
assert.strictEqual(impossiblePlan.batches.length, 0);
assert.strictEqual(impossiblePlan.reclaimableBytes, 150);

assert.deepStrictEqual(planBackupPruning(tasks, 0).batches, []);

console.log('Quota retention tests passed');
