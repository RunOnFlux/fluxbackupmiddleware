function groupBackupTasksByAge(tasks) {
  const batches = [];
  const batchMap = new Map();

  tasks.forEach((task) => {
    const key = `${task.appname}\u0000${task.timestamp}`;
    let batch = batchMap.get(key);
    if (!batch) {
      batch = {
        appname: task.appname,
        timestamp: task.timestamp,
        tasks: [],
        totalBytes: 0,
      };
      batchMap.set(key, batch);
      batches.push(batch);
    }
    batch.tasks.push(task);
    const filesize = Number(task.filesize);
    if (Number.isFinite(filesize) && filesize > 0) {
      batch.totalBytes += filesize;
    }
  });

  return batches.sort((first, second) => {
    const timestampDifference = Number(first.timestamp) - Number(second.timestamp);
    if (timestampDifference !== 0) return timestampDifference;
    return first.appname.localeCompare(second.appname);
  });
}

function planBackupPruning(tasks, bytesNeeded) {
  const normalizedBytesNeeded = Number(bytesNeeded);
  if (!Number.isFinite(normalizedBytesNeeded) || normalizedBytesNeeded <= 0) {
    return { canReclaim: true, batches: [], reclaimableBytes: 0 };
  }

  const batches = groupBackupTasksByAge(tasks);
  const reclaimableBytes = batches.reduce((total, batch) => total + batch.totalBytes, 0);
  if (reclaimableBytes < normalizedBytesNeeded) {
    return { canReclaim: false, batches: [], reclaimableBytes };
  }

  const selectedBatches = [];
  let selectedBytes = 0;
  for (let i = 0; i < batches.length && selectedBytes < normalizedBytesNeeded; i += 1) {
    selectedBatches.push(batches[i]);
    selectedBytes += batches[i].totalBytes;
  }

  return {
    canReclaim: true,
    batches: selectedBatches,
    reclaimableBytes,
    selectedBytes,
  };
}

module.exports = {
  groupBackupTasksByAge,
  planBackupPruning,
};
