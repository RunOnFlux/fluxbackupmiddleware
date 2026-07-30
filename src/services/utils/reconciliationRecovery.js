const RECONCILIATION_LOG_PATTERN = /Reconciled task (\d+): hash ([^\s]+) was absent from two consecutive FluxDrive inventories/g;

function extractReconciledTasks(contents) {
  const tasks = new Map();
  if (typeof contents !== 'string') return tasks;

  let match = RECONCILIATION_LOG_PATTERN.exec(contents);
  while (match) {
    tasks.set(Number(match[1]), match[2]);
    match = RECONCILIATION_LOG_PATTERN.exec(contents);
  }
  RECONCILIATION_LOG_PATTERN.lastIndex = 0;
  return tasks;
}

function isRecoverableTask(task, expectedHash) {
  if (!task || Number(task.uploaded) !== 0 || Number(task.removedFromFluxdrive) !== 1) {
    return false;
  }
  if (!task.hash || task.hash !== expectedHash || Number(task.reconciliationRecovered) !== 0) {
    return false;
  }

  try {
    const status = typeof task.status === 'string' ? JSON.parse(task.status) : task.status;
    return status?.state === 'finished';
  } catch (error) {
    return false;
  }
}

module.exports = {
  extractReconciledTasks,
  isRecoverableTask,
};
