function getPreviousUtcPeriod(now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - (24 * 60 * 60 * 1000);
  return {
    reportDate: new Date(start).toISOString().slice(0, 10),
    periodLabel: `${new Date(start).toISOString().slice(0, 10)} 00:00–24:00 UTC`,
    start,
    end,
  };
}

function getUtcDatePeriod(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date must use YYYY-MM-DD format');
  }
  const start = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date) {
    throw new Error('date is not a valid UTC calendar date');
  }
  return {
    reportDate: date,
    periodLabel: `${date} 00:00–24:00 UTC`,
    start,
    end: start + (24 * 60 * 60 * 1000),
  };
}

function getRolling24HourPeriod(now = new Date()) {
  const end = now.getTime();
  const start = end - (24 * 60 * 60 * 1000);
  return {
    reportDate: `rolling-${new Date(end).toISOString()}`,
    periodLabel: `${new Date(start).toISOString()} to ${new Date(end).toISOString()}`,
    start,
    end,
  };
}

function getMillisecondsUntilNextReport(now = new Date(), hourUtc = 0, minuteUtc = 5) {
  let target = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc,
    minuteUtc,
  );
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000;
  return target - now.getTime();
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / (1024 ** 2)).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${value} B`;
}

function formatCategory(label, runs, files) {
  return [
    `**${label}**`,
    `- Backup batches: ${runs.total} total — ${runs.successful} successful, ${runs.failed} failed`,
    `- Component files: ${files.total} total — ${files.successful} successful, ${files.failed} failed`,
    `- Successful size: ${formatBytes(files.successBytes)}`,
  ];
}

function buildDailyReportContent({
  reportDate,
  periodLabel,
  automaticRuns,
  automaticFiles,
  manualRuns,
  manualFiles,
}) {
  const totalSuccessfulFiles = automaticFiles.successful + manualFiles.successful;
  const totalFailedFiles = automaticFiles.failed + manualFiles.failed;
  const totalFiles = automaticFiles.total + manualFiles.total;
  const totalBytes = automaticFiles.successBytes + manualFiles.successBytes;
  return [
    '**Daily backup report**',
    `**Period:** ${periodLabel || `${reportDate} 00:00–24:00 UTC`}`,
    '',
    ...formatCategory('Automatic', automaticRuns, automaticFiles),
    '',
    ...formatCategory('Manual', manualRuns, manualFiles),
    '',
    '**Combined files**',
    `- ${totalFiles} total — ${totalSuccessfulFiles} successful, ${totalFailedFiles} failed`,
    `- Successful size: ${formatBytes(totalBytes)}`,
  ].join('\n');
}

module.exports = {
  getPreviousUtcPeriod,
  getUtcDatePeriod,
  getRolling24HourPeriod,
  getMillisecondsUntilNextReport,
  formatBytes,
  buildDailyReportContent,
};
