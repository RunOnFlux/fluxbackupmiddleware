const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const taskFileStorage = require('../src/services/utils/taskFileStorage');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-task-storage-'));
const firstTask = { taskId: 4524, filename: 'backup_wp.tar.gz' };
const secondTask = { taskId: 4527, filename: 'backup_wp.tar.gz' };

try {
  const firstPath = taskFileStorage.getTaskFilePath(firstTask, storageRoot);
  const secondPath = taskFileStorage.getTaskFilePath(secondTask, storageRoot);
  const firstPartialPath = taskFileStorage.getTaskPartialFilePath(firstTask, storageRoot);
  const secondPartialPath = taskFileStorage.getTaskPartialFilePath(secondTask, storageRoot);

  assert.notStrictEqual(firstPath, secondPath);
  assert.notStrictEqual(firstPartialPath, secondPartialPath);

  taskFileStorage.ensureTaskDirectory(firstTask, storageRoot);
  taskFileStorage.ensureTaskDirectory(secondTask, storageRoot);
  fs.writeFileSync(firstPath, 'first-final');
  fs.writeFileSync(firstPartialPath, 'first-partial');
  fs.writeFileSync(secondPath, 'second-final');
  fs.writeFileSync(secondPartialPath, 'second-partial');

  taskFileStorage.removeTaskArtifacts(firstTask, storageRoot);

  assert.strictEqual(fs.existsSync(firstPath), false);
  assert.strictEqual(fs.existsSync(firstPartialPath), false);
  assert.strictEqual(fs.existsSync(secondPath), true);
  assert.strictEqual(fs.existsSync(secondPartialPath), true);

  assert.throws(
    () => taskFileStorage.getTaskFilePath({ taskId: 1, filename: '../backup.tar.gz' }, storageRoot),
    /Invalid backup filename/,
  );

  console.log('Task file storage collision tests passed');
} finally {
  fs.rmSync(storageRoot, { recursive: true, force: true });
}
