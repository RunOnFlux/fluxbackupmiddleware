function getPreviousUtcPeriod(now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - (24 * 60 * 60 * 1000);
  return {
    reportDate: new Date(start).toISOString().slice(0, 10),
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
    `- Backups: ${runs.total} total — ${runs.successful} successful, ${runs.failed} failed`,
    `- Files: ${files.successful} successful, ${files.failed} failed`,
    `- Successful size: ${formatBytes(files.successBytes)}`,
  ];
}

function buildDailyReportContent({
  reportDate,
  automaticRuns,
  automaticFiles,
  manualRuns,
  manualFiles,
}) {
  const totalSuccessfulFiles = automaticFiles.successful + manualFiles.successful;
  const totalFailedFiles = automaticFiles.failed + manualFiles.failed;
  const totalBytes = automaticFiles.successBytes + manualFiles.successBytes;
  return [
    '**Daily backup report**',
    `**Period:** ${reportDate} 00:00–24:00 UTC`,
    '',
    ...formatCategory('Automatic', automaticRuns, automaticFiles),
    '',
    ...formatCategory('Manual', manualRuns, manualFiles),
    '',
    '**Combined files**',
    `- ${totalSuccessfulFiles} successful, ${totalFailedFiles} failed`,
    `- Successful size: ${formatBytes(totalBytes)}`,
  ].join('\n');
}

module.exports = {
  getPreviousUtcPeriod,
  getMillisecondsUntilNextReport,
  formatBytes,
  buildDailyReportContent,
};
