const assert = require('assert');

const dailyBackupReport = require('../src/services/utils/dailyBackupReport');

const period = dailyBackupReport.getPreviousUtcPeriod(
  new Date('2026-08-21T13:45:00.000Z'),
);
assert.deepStrictEqual(period, {
  reportDate: '2026-08-20',
  start: Date.parse('2026-08-20T00:00:00.000Z'),
  end: Date.parse('2026-08-21T00:00:00.000Z'),
});

assert.strictEqual(
  dailyBackupReport.getMillisecondsUntilNextReport(
    new Date('2026-08-21T00:04:00.000Z'),
    0,
    5,
  ),
  60 * 1000,
);
assert.strictEqual(
  dailyBackupReport.getMillisecondsUntilNextReport(
    new Date('2026-08-21T00:06:00.000Z'),
    0,
    5,
  ),
  (23 * 60 * 60 * 1000) + (59 * 60 * 1000),
);

assert.strictEqual(dailyBackupReport.formatBytes(0), '0 B');
assert.strictEqual(dailyBackupReport.formatBytes(1536), '1.50 KiB');
assert.strictEqual(dailyBackupReport.formatBytes(5 * 1024 * 1024), '5.00 MiB');

const content = dailyBackupReport.buildDailyReportContent({
  reportDate: '2026-08-20',
  automaticRuns: { total: 3, successful: 2, failed: 1 },
  automaticFiles: {
    total: 5,
    successful: 4,
    failed: 1,
    successBytes: 5 * 1024 * 1024,
  },
  manualRuns: { total: 2, successful: 1, failed: 1 },
  manualFiles: {
    total: 2,
    successful: 1,
    failed: 1,
    successBytes: 1536,
  },
});

assert(content.includes('**Period:** 2026-08-20 00:00–24:00 UTC'));
assert(content.includes('Backups: 3 total — 2 successful, 1 failed'));
assert(content.includes('Backups: 2 total — 1 successful, 1 failed'));
assert(content.includes('Successful size: 5.00 MiB'));
assert(content.includes('- 5 successful, 2 failed'));
assert(content.includes('Successful size: 5.00 MiB'));

console.log('daily backup report tests passed');
