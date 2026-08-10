const fs = require('fs');
const path = require('path');
const config = require('../../../config/default');

function validateTaskFile(task) {
  const taskId = String(task?.taskId ?? '');
  const filename = String(task?.filename ?? '');
  if (!/^\d+$/.test(taskId)) {
    throw new Error('Task ID is required for local backup storage');
  }
  if (!filename || path.basename(filename) !== filename) {
    throw new Error('Invalid backup filename');
  }
  return { taskId, filename };
}

function getTaskDirectory(task, storageRoot = config.storagePath) {
  const { taskId } = validateTaskFile(task);
  return path.join(storageRoot, taskId);
}

function getTaskFilePath(task, storageRoot = config.storagePath) {
  const { filename } = validateTaskFile(task);
  return path.join(getTaskDirectory(task, storageRoot), filename);
}

function getTaskPartialFilePath(task, storageRoot = config.storagePath) {
  return `${getTaskFilePath(task, storageRoot)}.part`;
}

function ensureTaskDirectory(task, storageRoot = config.storagePath) {
  const directory = getTaskDirectory(task, storageRoot);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function unlinkIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeTaskArtifacts(task, storageRoot = config.storagePath) {
  const finalPath = getTaskFilePath(task, storageRoot);
  const partialPath = getTaskPartialFilePath(task, storageRoot);
  const removedFinal = unlinkIfPresent(finalPath);
  const removedPartial = unlinkIfPresent(partialPath);
  const directory = getTaskDirectory(task, storageRoot);

  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
  }

  return { removedFinal, removedPartial };
}

module.exports = {
  ensureTaskDirectory,
  getTaskDirectory,
  getTaskFilePath,
  getTaskPartialFilePath,
  removeTaskArtifacts,
  unlinkIfPresent,
};
