/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const DBClient = require('./utils/DBClient');
const log = require('../lib/log');
const config = require('../../config/default');
const idService = require('./idService');
const messageHelper = require('./utils/messageHelper');
const fileManager = require('./fileService');
const fluxDrive = require('./fluxDrive');
const fluxOS = require('./fluxOsService');
const marketplaceService = require('./marketplaceService');
const enterpriseDiscoveryCache = require('./utils/enterpriseDiscoveryCache');
const discordNotifier = require('./discordNotifier');
const dailyBackupReport = require('./utils/dailyBackupReport');
const {
  extractReconciledTasks,
  isRecoverableTask,
} = require('./utils/reconciliationRecovery');
const {
  groupBackupTasksByAge,
  planBackupPruning,
} = require('./utils/quotaRetention');

let dbCli = null;

const taskQueue = new Map();
const userQuotaOperations = new Map();
const TASK_MAX_FAILURES = 4;
let fluxDriveReconciliationRunning = false;
let activeAutomaticBackupDispatchers = 0;
const automaticFailureNotifications = new Map();

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

async function recordBackupActivity(event) {
  try {
    await dbCli.execute(`
      INSERT IGNORE INTO backup_activity_events (
        event_key, event_kind, backup_type, appname, batch_key, task_id,
        outcome, file_count, filesize, stage, reason, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      event.eventKey,
      event.eventKind,
      event.backupType,
      event.appname,
      event.batchKey,
      event.taskId || null,
      event.outcome,
      event.fileCount || 0,
      event.filesize || 0,
      event.stage || null,
      event.reason ? String(event.reason).slice(0, 512) : null,
      event.occurredAt || Date.now(),
    ]);
  } catch (error) {
    log.error(`Failed to record backup activity ${event.eventKey}: ${getErrorMessage(error)}`);
  }
}

async function recordTaskActivity(task, outcome, stage, reason) {
  await recordBackupActivity({
    eventKey: `task:${task.taskId}`,
    eventKind: 'file',
    backupType: task.backup_type || 'manual',
    appname: task.appname,
    batchKey: `${task.backup_type || 'manual'}:${task.appname}:${task.timestamp}`,
    taskId: task.taskId,
    outcome,
    fileCount: outcome === 'success' ? 1 : 0,
    filesize: outcome === 'success' ? Number(task.filesize) || 0 : 0,
    stage,
    reason,
  });
}

async function recordAutomaticRunActivity({
  automaticBackup,
  runStartedAt,
  batchKey,
  outcome,
  fileCount = 0,
  filesize = 0,
  stage,
  reason,
}) {
  if (!automaticBackup || !runStartedAt) return;
  await recordBackupActivity({
    eventKey: `automatic-run:${automaticBackup.id}:${runStartedAt}`,
    eventKind: 'run',
    backupType: 'automatic',
    appname: automaticBackup.appname,
    batchKey: batchKey || `automatic:${automaticBackup.appname}:${runStartedAt}`,
    outcome,
    fileCount,
    filesize,
    stage,
    reason,
  });
}

function emptyReportMetric() {
  return {
    total: 0, successful: 0, failed: 0, successBytes: 0,
  };
}

async function backfillTerminalTaskActivity(period) {
  await dbCli.execute(`
    INSERT IGNORE INTO backup_activity_events (
      event_key, event_kind, backup_type, appname, batch_key, task_id,
      outcome, file_count, filesize, stage, reason, occurred_at
    )
    SELECT
      CONCAT('task:', taskId),
      'file',
      CASE WHEN backup_type LIKE 'automatic%' THEN 'automatic' ELSE 'manual' END,
      appname,
      CONCAT(
        CASE WHEN backup_type LIKE 'automatic%' THEN 'automatic' ELSE 'manual' END,
        ':', appname, ':', timestamp
      ),
      taskId,
      CASE WHEN status LIKE '%"state":"finished"%' THEN 'success' ELSE 'failed' END,
      CASE WHEN status LIKE '%"state":"finished"%' THEN 1 ELSE 0 END,
      CASE WHEN status LIKE '%"state":"finished"%' THEN COALESCE(filesize, 0) ELSE 0 END,
      CASE WHEN status LIKE '%"state":"finished"%' THEN 'completed' ELSE 'task_pipeline' END,
      LEFT(status, 512),
      CASE WHEN finishTime > 0 THEN finishTime * 1000 ELSE startTime * 1000 END
    FROM tasks
    WHERE (
      (finishTime > 0 AND finishTime * 1000 >= ? AND finishTime * 1000 < ?)
      OR (finishTime = 0 AND fails >= ? AND startTime * 1000 >= ? AND startTime * 1000 < ?)
    )
  `, [period.start, period.end, TASK_MAX_FAILURES, period.start, period.end]);
}

async function collectDailyBackupMetrics(period) {
  await backfillTerminalTaskActivity(period);
  const now = Date.now();
  const marketplaceCutoff = now - (
    config.automaticBackupSchedule.marketplaceIntervalHours * 60 * 60 * 1000
  );
  const [appInventoryRow] = await dbCli.execute(`
    SELECT
      COALESCE(SUM(status IS NULL OR status != 'cancelled'), 0) AS active_apps,
      COALESCE(SUM((status IS NULL OR status != 'cancelled') AND is_marketplace = 1), 0)
        AS marketplace_apps,
      COALESCE(SUM(
        status != 'cancelled' AND is_marketplace = 1 AND status = 'pending'
        AND dispatch_token IS NOT NULL AND dispatch_lease_until > 0
        AND dispatch_lease_until < ?
      ), 0) AS stale_marketplace_leases,
      COALESCE(SUM(
        status != 'cancelled' AND is_marketplace = 1
        AND last_backup_timestamp < ?
      ), 0) AS overdue_marketplace_apps
    FROM automatic_backups
  `, [now, marketplaceCutoff]);
  const aggregateRows = await dbCli.execute(`
    SELECT
      CASE WHEN backup_type LIKE 'automatic%' THEN 'automatic' ELSE 'manual' END AS report_type,
      event_kind, outcome, COUNT(*) AS event_count,
      COALESCE(SUM(filesize), 0) AS total_size
    FROM backup_activity_events
    WHERE occurred_at >= ? AND occurred_at < ?
    GROUP BY report_type, event_kind, outcome
  `, [period.start, period.end]);

  const automaticRuns = emptyReportMetric();
  const automaticFiles = emptyReportMetric();
  const manualFiles = emptyReportMetric();
  aggregateRows.forEach((row) => {
    const count = Number(row.event_count) || 0;
    const bytes = Number(row.total_size) || 0;
    let target = null;
    if (row.report_type === 'automatic' && row.event_kind === 'file') {
      target = automaticFiles;
    } else if (row.report_type === 'manual' && row.event_kind === 'file') {
      target = manualFiles;
    }
    if (!target) return;
    target.total += count;
    if (row.outcome === 'success') {
      target.successful += count;
      target.successBytes += bytes;
    } else if (row.outcome === 'failed') {
      target.failed += count;
    }
  });

  const batchRows = await dbCli.execute(`
    SELECT
      events.appname,
      CASE WHEN events.backup_type LIKE 'automatic%' THEN 'automatic' ELSE 'manual' END
        AS report_type,
      CONCAT(events.appname, ':', SUBSTRING_INDEX(events.batch_key, ':', -1))
        AS report_batch,
      MAX(
        apps.is_marketplace = 1 AND (apps.status IS NULL OR apps.status != 'cancelled')
      ) AS is_active_marketplace,
      SUM(events.event_kind = 'run' AND events.outcome = 'success') AS successful_runs,
      SUM(events.event_kind = 'run' AND events.outcome = 'failed') AS failed_runs,
      SUM(events.event_kind = 'file' AND events.outcome = 'success') AS successful_files,
      SUM(events.event_kind = 'file' AND events.outcome = 'failed') AS failed_files
    FROM backup_activity_events events
    LEFT JOIN automatic_backups apps
      ON events.appname COLLATE utf8mb4_unicode_ci
        = apps.appname COLLATE utf8mb4_unicode_ci
    WHERE events.occurred_at >= ? AND events.occurred_at < ?
    GROUP BY events.appname, report_type, report_batch
  `, [period.start, period.end]);
  const manualRuns = emptyReportMetric();
  const attemptedMarketplaceApps = new Set();
  const successfulMarketplaceApps = new Set();
  batchRows.forEach((row) => {
    const target = row.report_type === 'automatic' ? automaticRuns : manualRuns;
    const failed = Number(row.failed_runs) > 0 || Number(row.failed_files) > 0;
    const successful = Number(row.successful_runs) > 0 || Number(row.successful_files) > 0;
    if (!failed && !successful) return;
    target.total += 1;
    if (failed) target.failed += 1;
    else target.successful += 1;
    if (row.report_type === 'automatic' && Number(row.is_active_marketplace) === 1) {
      attemptedMarketplaceApps.add(row.appname);
      if (!failed && successful) successfulMarketplaceApps.add(row.appname);
    }
  });

  const marketplaceApps = Number(appInventoryRow?.marketplace_apps) || 0;
  const marketplaceAttempted = attemptedMarketplaceApps.size;
  const marketplaceSuccessful = successfulMarketplaceApps.size;

  return {
    appInventory: {
      active: Number(appInventoryRow?.active_apps) || 0,
      marketplace: marketplaceApps,
    },
    marketplaceCoverage: {
      attempted: marketplaceAttempted,
      successful: marketplaceSuccessful,
      failedOrIncomplete: Math.max(marketplaceAttempted - marketplaceSuccessful, 0),
      noActivity: Math.max(marketplaceApps - marketplaceAttempted, 0),
      staleLeases: Number(appInventoryRow?.stale_marketplace_leases) || 0,
      overdue: Number(appInventoryRow?.overdue_marketplace_apps) || 0,
    },
    automaticRuns,
    automaticFiles,
    manualRuns,
    manualFiles,
  };
}

async function generateDailyBackupReport(period) {
  const metrics = await collectDailyBackupMetrics(period);
  const content = dailyBackupReport.buildDailyReportContent({
    reportDate: period.reportDate,
    periodLabel: period.periodLabel,
    ...metrics,
  });
  return { period, metrics, content };
}

async function claimDailyBackupReport(reportDate) {
  const now = Date.now();
  const insertResult = await dbCli.execute(`
    INSERT IGNORE INTO daily_backup_reports (report_date, status, reserved_at)
    VALUES (?, 'sending', ?)
  `, [reportDate, now]);
  if (insertResult.affectedRows === 1) return true;

  const reclaimResult = await dbCli.execute(`
    UPDATE daily_backup_reports
    SET reserved_at = ?
    WHERE report_date = ? AND status = 'sending' AND reserved_at < ?
  `, [now, reportDate, now - (60 * 60 * 1000)]);
  return reclaimResult.affectedRows === 1;
}

async function sendDailyBackupReport(period = dailyBackupReport.getPreviousUtcPeriod()) {
  let claimed = false;
  try {
    claimed = await claimDailyBackupReport(period.reportDate);
    if (!claimed) return null;

    const { content } = await generateDailyBackupReport(period);
    const sent = await discordNotifier.sendDailyBackupReport(content, period.reportDate);
    if (!sent) {
      await dbCli.execute(
        "DELETE FROM daily_backup_reports WHERE report_date = ? AND status = 'sending'",
        [period.reportDate],
      );
      return false;
    }
    await dbCli.execute(`
      UPDATE daily_backup_reports SET status = 'sent', sent_at = ? WHERE report_date = ?
    `, [Date.now(), period.reportDate]);
    return true;
  } catch (error) {
    log.error(`Daily backup report failed for ${period.reportDate}: ${getErrorMessage(error)}`);
    if (claimed) {
      try {
        await dbCli.execute(
          "DELETE FROM daily_backup_reports WHERE report_date = ? AND status = 'sending'",
          [period.reportDate],
        );
      } catch (releaseError) {
        log.error(`Failed to release daily report claim: ${getErrorMessage(releaseError)}`);
      }
    }
    return false;
  }
}

function isLocalReportRequest(req) {
  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const host = String(req.headers?.host || '').toLowerCase();
  const hostname = host.startsWith('[') && host.includes(']')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const forwarded = req.headers?.['x-forwarded-for'] || req.headers?.forwarded;
  return loopbackAddresses.has(remoteAddress) && localHosts.has(hostname) && !forwarded;
}

function getRequestedReportPeriod(req) {
  const date = typeof req.query?.date === 'string' ? req.query.date.trim() : '';
  return date
    ? dailyBackupReport.getUtcDatePeriod(date)
    : dailyBackupReport.getRolling24HourPeriod();
}

async function getDailyBackupReport(req, res) {
  if (!isLocalReportRequest(req)) {
    res.status(403).json({ error: 'This endpoint is available only through localhost' });
    return;
  }
  try {
    const report = await generateDailyBackupReport(getRequestedReportPeriod(req));
    res.json(report);
  } catch (error) {
    const invalidDate = getErrorMessage(error).startsWith('date ');
    log.error(`Local daily backup report preview failed: ${getErrorMessage(error)}`);
    res.status(invalidDate ? 400 : 500).json({ error: getErrorMessage(error) });
  }
}

async function forceSendDailyBackupReport(req, res) {
  if (!isLocalReportRequest(req)) {
    res.status(403).json({ error: 'This endpoint is available only through localhost' });
    return;
  }
  try {
    const report = await generateDailyBackupReport(getRequestedReportPeriod(req));
    const sent = await discordNotifier.sendDailyBackupReport(
      report.content,
      report.period.reportDate,
    );
    if (!sent) {
      res.status(502).json({ error: 'Discord report delivery failed', ...report });
      return;
    }
    log.info(`Forced daily backup report sent for ${report.period.periodLabel}`);
    res.json({ sent: true, ...report });
  } catch (error) {
    const invalidDate = getErrorMessage(error).startsWith('date ');
    log.error(`Forced daily backup report failed: ${getErrorMessage(error)}`);
    res.status(invalidDate ? 400 : 500).json({ error: getErrorMessage(error) });
  }
}

function scheduleNextDailyBackupReport() {
  const reportConfig = config.dailyBackupReport;
  const delay = dailyBackupReport.getMillisecondsUntilNextReport(
    new Date(),
    reportConfig.hourUtc,
    reportConfig.minuteUtc,
  );
  setTimeout(async () => {
    const period = dailyBackupReport.getPreviousUtcPeriod();
    const sent = await sendDailyBackupReport(period);
    if (sent === false) {
      setTimeout(async () => {
        await sendDailyBackupReport(period);
      }, 60 * 60 * 1000);
    }
    scheduleNextDailyBackupReport();
  }, delay);
}

function getQuotaLimitBytes() {
  return config.quotaPerUser * 1024 * 1024 * 1024;
}

async function getUserStorageUsed(owner) {
  const query = `
    SELECT SUM(filesize) AS totalUsed
    FROM tasks
    WHERE owner = ?
    AND removedFromFluxdrive = 0
    AND (uploaded = 1 OR (uploaded = 0 AND finishTime = 0 AND fails < ?))
  `;
  const params = [owner, TASK_MAX_FAILURES];
  const totalUsed = await dbCli.execute(query, params);
  if (totalUsed.length > 0 && totalUsed[0].totalUsed) {
    return Number(totalUsed[0].totalUsed);
  }
  return 0;
}

async function logFluxDriveStoredSize() {
  try {
    const rows = await dbCli.execute(`
      SELECT COUNT(*) AS fileCount, COALESCE(SUM(filesize), 0) AS totalBytes
      FROM tasks
      WHERE uploaded = 1
      AND removedFromFluxdrive = 0
    `);
    const inventory = rows?.[0];
    const totalBytes = Number(inventory?.totalBytes ?? 0);
    const fileCount = Number(inventory?.fileCount ?? 0);

    if (!Number.isFinite(totalBytes) || !Number.isFinite(fileCount)) {
      log.warn('Could not calculate FluxDrive stored backup size from database values');
      return;
    }

    const totalMiB = (totalBytes / (1024 * 1024)).toFixed(2);
    const totalGiB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
    log.info(`FluxDrive active storage at startup: files=${fileCount}, totalSize=${totalBytes} bytes (${totalMiB} MiB, ${totalGiB} GiB)`);
  } catch (error) {
    log.warn(`Could not log FluxDrive stored backup size at startup: ${getErrorMessage(error)}`);
  }
}

function getFluxDriveRemovalError(removeResult) {
  if (!removeResult || removeResult.status === 'error' || removeResult.success === false) {
    return removeResult?.message || 'FluxDrive rejected the file removal';
  }
  return null;
}

function createBackupFailure(reason, stage, taskFailures = [], diagnostics = []) {
  const error = new Error(reason);
  error.stage = stage;
  error.taskFailures = taskFailures;
  error.diagnostics = diagnostics;
  return error;
}

function inferFailureStage(error) {
  if (error.stage) return error.stage;

  const message = getErrorMessage(error);
  if (
    message.includes('Query inactivity timeout')
    || message.includes('Database operation timed out')
    || String(error.code || '').startsWith('ER_')
  ) return 'database';
  if (message.includes('secondary node')) return 'node_selection';
  if (message.includes('authenticate')) return 'node_auth';
  if (message.includes('app owner')) return 'app_owner';
  if (message.includes('create backup tasks')) return 'create_backup';
  if (message.includes('Could not queue backup')) return 'create_backup';
  if (message.includes('Timeout waiting for tasks')) return 'task_timeout';
  return 'automatic_backup';
}

function buildAutomaticFailureFingerprint(payload) {
  const stableFailure = {
    stage: payload.stage,
    reason: payload.reason,
    taskFailures: (payload.taskFailures || []).map((failure) => ({
      component: failure.component,
      message: failure.message,
      node: failure.node,
      errorCode: failure.errorCode,
      httpStatus: failure.httpStatus,
    })),
    attempts: (payload.failureAttempts || []).map((attempt) => ({
      stage: attempt.stage,
      reason: attempt.reason,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(stableFailure)).digest('hex');
}

async function notifyAutomaticBackupFailureOnce(
  automaticBackup,
  payload,
  database = dbCli,
  notifier = discordNotifier,
  notificationCache = automaticFailureNotifications,
) {
  const fingerprint = buildAutomaticFailureFingerprint(payload);
  const now = Date.now();
  const cooldownMs = config.automaticBackupSchedule.discordFailureCooldownMinutes
    * 60 * 1000;
  const cached = notificationCache.get(automaticBackup.id);
  if (cached && cached.fingerprint === fingerprint && cached.notifiedAt >= now - cooldownMs) {
    log.warn(`Suppressed duplicate Discord failure notification for ${automaticBackup.appname} (memory cooldown)`);
    return false;
  }

  let databaseReservation = false;
  try {
    const reservation = await database.execute(`
      UPDATE automatic_backups
      SET last_failure_fingerprint = ?, last_failure_notified_at = ?
      WHERE id = ? AND (
        last_failure_fingerprint IS NULL
        OR last_failure_fingerprint != ?
        OR last_failure_notified_at < ?
      )
    `, [fingerprint, now, automaticBackup.id, fingerprint, now - cooldownMs]);
    if (reservation.affectedRows !== 1) {
      log.warn(`Suppressed duplicate Discord failure notification for ${automaticBackup.appname} (database cooldown)`);
      notificationCache.set(automaticBackup.id, { fingerprint, notifiedAt: now });
      return false;
    }
    databaseReservation = true;
  } catch (error) {
    log.error(`Could not reserve Discord failure notification for ${automaticBackup.appname}; using memory cooldown: ${getErrorMessage(error)}`);
  }

  notificationCache.set(automaticBackup.id, { fingerprint, notifiedAt: now });
  const sent = await notifier.notifyAutomaticBackupFailure(payload);
  if (!sent) {
    notificationCache.delete(automaticBackup.id);
    if (databaseReservation) {
      try {
        await database.execute(`
          UPDATE automatic_backups SET last_failure_notified_at = 0
          WHERE id = ? AND last_failure_fingerprint = ? AND last_failure_notified_at = ?
        `, [automaticBackup.id, fingerprint, now]);
      } catch (error) {
        log.error(`Failed to release Discord notification reservation for ${automaticBackup.appname}: ${getErrorMessage(error)}`);
      }
    }
  }
  return sent;
}

const TASK_PROGRESS_STATES = new Set(['in queue', 'started', 'downloading', 'uploading']);

function getTaskStatusState(task) {
  return String(task?.status?.state || '').trim().toLowerCase();
}

function getTaskOutcome(task) {
  if (!task) {
    return { state: 'failed', reason: 'Task not found in database' };
  }

  const fails = Number(task.fails) || 0;
  const finishTime = Number(task.finishTime) || 0;
  const uploaded = Number(task.uploaded) === 1;
  const statusState = getTaskStatusState(task);
  const statusMessage = task.status?.message;

  if (fails >= TASK_MAX_FAILURES) {
    return {
      state: 'failed',
      reason: TASK_PROGRESS_STATES.has(statusState)
        ? `Task failed ${fails} times`
        : statusMessage || `Task failed ${fails} times`,
    };
  }

  // A zero finishTime may be returned as either 0 or "0" by the database.
  // Progress status messages must never be interpreted as terminal failures.
  if (finishTime <= 0) {
    return { state: 'pending' };
  }

  if (uploaded && statusState === 'finished') {
    return { state: 'success' };
  }

  return {
    state: 'failed',
    reason: TASK_PROGRESS_STATES.has(statusState)
      ? 'Task ended before the FluxDrive upload completed'
      : statusMessage || 'Task did not upload successfully',
  };
}

function buildTaskFailure(task, taskId, reason) {
  let node = null;
  let storedDiagnostic = null;
  if (task?.extra) {
    try {
      storedDiagnostic = JSON.parse(task.extra).failureDiagnostic || null;
    } catch (error) {
      storedDiagnostic = null;
    }
  }
  if (task?.host) {
    try {
      node = new URL(task.host).origin;
    } catch (error) {
      [node] = String(task.host).split('/backup/');
    }
  }
  return {
    taskId,
    component: task?.component || 'unknown',
    message: reason,
    fails: task?.fails || 0,
    node: storedDiagnostic?.node || node,
    endpoint: storedDiagnostic?.endpoint || task?.host || null,
    httpStatus: storedDiagnostic?.httpStatus || null,
    errorCode: storedDiagnostic?.errorCode || null,
    fileSize: Number(storedDiagnostic?.fileSize ?? task?.filesize) || 0,
    receivedSize: storedDiagnostic?.receivedSize !== null
      && typeof storedDiagnostic?.receivedSize !== 'undefined'
      && Number.isFinite(Number(storedDiagnostic.receivedSize))
      ? Number(storedDiagnostic.receivedSize) : null,
    responseBody: storedDiagnostic?.responseBody || null,
    check: storedDiagnostic?.check || null,
  };
}

async function collectTaskFailures(taskIds, reason) {
  const failures = [];
  for (let i = 0; i < taskIds.length; i += 1) {
    const taskId = taskIds[i];
    const task = await dbCli.getTask(taskId);
    const outcome = getTaskOutcome(task);
    if (outcome.state !== 'success') {
      failures.push(buildTaskFailure(
        task,
        taskId,
        outcome.state === 'failed' ? outcome.reason : reason,
      ));
    }
  }
  return failures;
}

function getRegistrationErrorFromResponse(data) {
  if (!data) {
    return 'No response from backup task registration';
  }

  if (data.status === 'error' && data.data) {
    return data.data.message || 'Backup task registration was rejected';
  }

  if (data.status === 'success' && data.data) {
    if (data.data.taskId) {
      return null;
    }
    return 'Backup task was not assigned an ID (database or queue issue)';
  }

  return 'Unexpected response from backup task registration';
}

function createRegistrationMocks() {
  let lastResponse = null;
  const mockRes = {
    json: (data) => {
      lastResponse = data;
    },
  };

  return {
    mockRes,
    getTaskId: () => (
      lastResponse?.status === 'success' && lastResponse?.data?.taskId
        ? lastResponse.data.taskId
        : null
    ),
    getError: () => getRegistrationErrorFromResponse(lastResponse),
  };
}

function summarizeRegistrationFailures(failures) {
  if (!failures.length) {
    return 'Backup files were created on the node but could not be queued for upload';
  }

  const messages = [...new Set(failures.map((failure) => failure.message))];
  const components = failures.map((failure) => failure.component).join(', ');

  if (messages.length === 1) {
    return `Could not queue backup for components [${components}]: ${messages[0]}`;
  }

  return `Could not queue backup for ${failures.length} components (${components})`;
}

async function cancelTaskDueToQuota(task, taskId, filesize) {
  log.warn(`Cancelling task ${taskId}: ${filesize} bytes cannot fit within user quota after automatic-backup pruning`);
  const cancelledTask = {
    ...task,
    status: { state: 'cancelled', message: 'user quota exceeded and insufficient automatic backups can be removed', progress: 0 },
    finishTime: Math.floor(Date.now() / 1000),
    removedFromFluxdrive: 1,
    uploaded: 0,
  };
  // eslint-disable-next-line no-use-before-define
  const remoteRemoved = await removeBackupFromRemoteHost(cancelledTask.host, taskId);
  if (remoteRemoved) cancelledTask.remoteRemoved = 1;
  if (fileManager.fileExists(cancelledTask) || !cancelledTask.localRemoved) {
    try {
      await fileManager.deleteFile(cancelledTask);
      cancelledTask.localRemoved = 1;
    } catch (error) {
      log.error(`Failed to remove local file for quota-cancelled task ${taskId}: ${getErrorMessage(error)}`);
    }
  }
  await dbCli.updateTask(cancelledTask);
  await recordTaskActivity(
    cancelledTask,
    'failed',
    'quota',
    cancelledTask.status.message,
  );
  taskQueue.delete(Number(taskId));
}

function runUserQuotaOperation(owner, operation) {
  const previousOperation = userQuotaOperations.get(owner) || Promise.resolve();
  const currentOperation = previousOperation.catch(() => {}).then(operation);
  userQuotaOperations.set(owner, currentOperation);
  return currentOperation.finally(() => {
    if (userQuotaOperations.get(owner) === currentOperation) {
      userQuotaOperations.delete(owner);
    }
  });
}

async function getQuotaPruningCandidates(task) {
  return dbCli.execute(`
    SELECT retained_task.taskId, retained_task.appname, retained_task.timestamp,
      retained_task.hash, retained_task.filename, retained_task.filesize
    FROM tasks AS retained_task
    WHERE retained_task.owner = ?
    AND retained_task.backup_type = 'automatic'
    AND retained_task.uploaded = 1
    AND retained_task.removedFromFluxdrive = 0
    AND retained_task.finishTime > 0
    AND retained_task.hash IS NOT NULL
    AND retained_task.hash <> ''
    AND NOT (retained_task.appname = ? AND retained_task.timestamp = ?)
    AND NOT EXISTS (
      SELECT 1
      FROM tasks AS pending_task
      WHERE pending_task.owner = retained_task.owner
      AND pending_task.appname = retained_task.appname
      AND pending_task.timestamp = retained_task.timestamp
      AND pending_task.removedFromFluxdrive = 0
      AND pending_task.uploaded = 0
      AND pending_task.finishTime = 0
      AND pending_task.fails < ?
    )
    ORDER BY retained_task.timestamp ASC, retained_task.taskId ASC
  `, [task.owner, task.appname, task.timestamp, TASK_MAX_FAILURES]);
}

async function ensureUserQuotaForDownloadedTask(task) {
  return runUserQuotaOperation(task.owner, async () => {
    const quotaLimit = getQuotaLimitBytes();
    const taskFilesize = Number(task.filesize);
    if (!Number.isFinite(taskFilesize) || taskFilesize < 0 || taskFilesize > quotaLimit) {
      return false;
    }

    let usedBytes = await getUserStorageUsed(task.owner);
    if (usedBytes <= quotaLimit) return true;

    const bytesNeeded = usedBytes - quotaLimit;
    const candidates = await getQuotaPruningCandidates(task);
    const pruningPlan = planBackupPruning(candidates, bytesNeeded);
    const batches = groupBackupTasksByAge(candidates);

    if (!pruningPlan.canReclaim) {
      log.warn(`Quota pruning cannot fit task ${task.taskId}: need=${bytesNeeded} bytes, reclaimable=${pruningPlan.reclaimableBytes} bytes`);
      return false;
    }

    log.info(`Quota pruning for task ${task.taskId}: used=${usedBytes}, limit=${quotaLimit}, need=${bytesNeeded}, candidateBatches=${batches.length}`);
    for (let batchIndex = 0; batchIndex < batches.length && usedBytes > quotaLimit; batchIndex += 1) {
      const batch = batches[batchIndex];
      log.info(`Removing oldest automatic backup batch: app=${batch.appname}, timestamp=${batch.timestamp}, files=${batch.tasks.length}, size=${batch.totalBytes}`);

      for (let taskIndex = 0; taskIndex < batch.tasks.length; taskIndex += 1) {
        const oldTask = batch.tasks[taskIndex];
        const removeResult = await fluxDrive.removeFileVerified(oldTask.hash);
        const removalError = getFluxDriveRemovalError(removeResult);
        if (removalError) {
          log.error(`Quota pruning failed for task ${oldTask.taskId}: ${removalError}`);
        } else {
          const updateResult = await dbCli.softRemoveTask(oldTask.taskId);
          if (updateResult?.affectedRows === 1) {
            log.info(`Quota pruning removed task ${oldTask.taskId} (${oldTask.filesize} bytes)`);
          } else {
            log.error(`Quota pruning could not update removed task ${oldTask.taskId}`);
          }
        }
      }

      usedBytes = await getUserStorageUsed(task.owner);
    }

    if (usedBytes > quotaLimit) {
      log.warn(`Quota pruning did not free enough space for task ${task.taskId}: used=${usedBytes}, limit=${quotaLimit}`);
      return false;
    }

    log.info(`Quota pruning completed for task ${task.taskId}: used=${usedBytes}, limit=${quotaLimit}`);
    return true;
  });
}

/**
 * This function runs a task with a given ID. It updates the task status in the database,
 * downloads the file associated with the task if it's not already downloaded, uploads the file
 * to FluxDrive if it's not already uploaded, and removes the local file once it's uploaded.
 * If any step fails, it increments the task's fail count and logs the failure.
 *
 * @async
 * @param {string|number} id - The ID of the task to run.
 * @throws Will throw an error if the task fails.
 */
async function runTask(id) {
  log.info(`ruuning task ${id}`);
  const task = taskQueue.get(id);
  if (!task) {
    log.error(`Cannot run task ${id}: task is not registered in the in-memory queue`);
    return;
  }
  try {
    if (task.extra) {
      try {
        if (JSON.parse(task.extra).failureDiagnostic) task.extra = '';
      } catch (error) {
        // Preserve non-diagnostic legacy task metadata.
      }
    }
    task.startTime = Math.floor(Date.now() / 1000);
    task.status = { state: 'started', message: 'backup to FluxDrive started', progress: 0 };
    await dbCli.updateTask(task);
    // check if file is downloaded
    if (!task.downloaded || task.localRemoved || !fileManager.fileExists(task)) {
      // download the file
      log.info(`downloading task ${id}.`);
      task.status = { state: 'downloading', message: 'fetching file from node', progress: 0 };
      await dbCli.updateTask(task);
      await fileManager.downloadFileFromHost(task);
      // task.status = { state: 'downloading', message: 'fetching file from node', progress: 100 };
      await dbCli.updateTask(task);
    }
    if (!task.uploaded) {
      // Revalidate here as well as at registration so legacy queued tasks cannot
      // retain an oversized downloaded artifact after FluxDrive rejects it.
      fileManager.validateFluxDriveFileSize(task);
    }
    if (!task.uploaded && !await ensureUserQuotaForDownloadedTask(task)) {
      await cancelTaskDueToQuota(task, id, task.filesize);
      return;
    }
    // check if file is uploaded
    if (!task.uploaded) {
      // upload the file
      log.info(`uploading task ${id}.`);
      task.status = { state: 'uploading', message: 'uploading file to FluxDrive', progress: 0 };
      await dbCli.updateTask(task);
      await fluxDrive.uploadFile(task);
      // task.status = { state: 'uploading', message: 'uploading file to FluxDrive', progress: 100 };
      await dbCli.updateTask(task);
    }
    // check if the file is removed locally
    if (fileManager.fileExists(task) || !task.localRemoved) {
      // remove the file locally
      log.info(`removing local file for task ${id}.`);
      await fileManager.deleteFile(task);
      task.localRemoved = true;
      await dbCli.updateTask(task);
    }
    // ask remote server to remove the file

    // mark the task as done and remove from queue
    log.info(`task ${id} finished.`);
    task.status = { state: 'finished', message: 'finished', progress: 100 };
    task.finishTime = Math.floor(Date.now() / 1000);
    task.extra = '';
    await dbCli.updateTask(task);
    await recordTaskActivity(task, 'success', 'completed', 'finished');
  } catch (error) {
    const message = getErrorMessage(error);
    const deferredForStorage = error.deferWithoutFailure === true;
    if (deferredForStorage || !task.status || task.status.state !== 'failed') {
      task.status = {
        state: deferredForStorage ? 'waiting' : 'failed',
        message,
        progress: 0,
      };
    }
    if (error.diagnostic) {
      task.extra = JSON.stringify({ failureDiagnostic: error.diagnostic });
    }
    if (error.terminal === true) task.fails = TASK_MAX_FAILURES;
    else if (!deferredForStorage) task.fails += 1;

    if (task.fails >= TASK_MAX_FAILURES) {
      try {
        fileManager.deleteFile(task);
        task.localRemoved = true;
        log.info(`Removed local artifacts for terminally failed task ${id}`);
      } catch (cleanupError) {
        log.error(`Failed to remove local artifacts for terminally failed task ${id}: ${cleanupError.message}`);
      }
    }
    try {
      await dbCli.updateTask(task);
    } catch (persistenceError) {
      log.error(`Failed to persist failure state for task ${id}: ${getErrorMessage(persistenceError)}`);
    }
    if (task.fails >= TASK_MAX_FAILURES) {
      try {
        await recordTaskActivity(task, 'failed', task.status?.state || 'task_pipeline', message);
      } catch (activityError) {
        log.error(`Failed to record failure activity for task ${id}: ${getErrorMessage(activityError)}`);
      }
    }
    if (deferredForStorage) {
      log.warn(`task ${id} deferred until local storage capacity is available: ${message}`);
    } else {
      log.error(`task ${id} failed:`, error instanceof Error ? error : message);
    }
  } finally {
    taskQueue.delete(id);
  }
}

function launchTask(id) {
  runTask(id).catch((error) => {
    taskQueue.delete(id);
    log.error(`Unexpected task runner rejection for task ${id}: ${getErrorMessage(error)}`);
  });
}

/**
 * This function updates the task queue. It first removes any tasks from the queue that have been running for more than an hour.
 * Then, if the queue has space, it fetches the latest remaining tasks from the database and adds them to the queue.
 * It only fetches tasks that have not finished and have attempts remaining.
 * It then runs each newly added task.
 *
 * @async
 * @throws Will throw an error if the database query fails.
 */
async function updateQueue() {
  // remove failed tasks from queue
  const now = Math.floor(Date.now() / 1000);
  const failTime = 30 * 60; // 30 minutes
  taskQueue.forEach((value, key) => {
    if (now - value.startTime > failTime) {
      log.info(`deleting ${key} from queue.`);
      taskQueue.delete(key);
    }
  });
  // check if queue has space
  if (taskQueue.size < config.maxConcurrentTasks) {
    // read latest remaining tasks from db
    const emptySlots = config.maxConcurrentTasks - taskQueue.size;
    const records = await dbCli.execute(`select * from tasks where finishTime=0 and fails<${TASK_MAX_FAILURES} order by timestamp limit ${Number(emptySlots)}`);
    // if (records.length) log.debug(`${records.length} failed tasks, retrying...`);
    for (let i = 0; i < records.length; i += 1) {
      if (!taskQueue.has(records[i].taskId)) {
        // add task to the queue
        taskQueue.set(Number(records[i].taskId), records[i]);
        // run task
        log.debug(`retrying task ${records[i].taskId}`);
        launchTask(Number(records[i].taskId));
      } else {
        // log.warn(`task ${records[i].taskId} already in queue.`);
      }
    }
    // console.log(taskQueue.entries());
  }
}

/**
 * Checks expired apps and removes all backup files linked to it from FluxDrive.
 *
 * @async
 * @throws Will throw an error if the database query fails.
 */
async function checkExpiredApps() {
  try {
    log.info('checkExpiredApps...');
    let expireHeight = await fluxOS.getBlockHeight();
    if (expireHeight !== false && expireHeight > 1000) {
      expireHeight -= 720 * 7 * 4; // 7 days
      // get apps that have been expired more than 7 days
      const records = await dbCli.execute(`select * from tasks where removedFromFluxdrive = 0 and uploaded = 1 and appExpireHeight > 0  and appExpireHeight < ${Number(expireHeight)} order by appExpireHeight ASC limit 10`);
      // eslint-disable-next-line no-restricted-syntax
      for (record of records) {
        // check if they have been extended
        const appSpecs = await fluxOS.getAppSpecs(record.appname, true);
        if (appSpecs && appSpecs !== 'Application not found' && appSpecs.expire + appSpecs.height !== record.appExpireHeight) {
          if (appSpecs.owner === record.owner) {
            log.info(`id: ${record.taskId}, appname: ${record.appname} expire height updated.`);
            record.appExpireHeight = appSpecs.expire + appSpecs.height;
            await dbCli.updateTask(record);
          } else {
            log.info(`id: ${record.taskId}, appname: ${record.appname} has a new owner. removing file from FluxDrive`);
            const removeResult = await fluxDrive.removeFileVerified(record.hash);
            const removalError = getFluxDriveRemovalError(removeResult);
            if (removalError) {
              log.error(`Failed to remove expired-app task ${record.taskId}: ${removalError}`);
            } else {
              await dbCli.softRemoveTask(record.taskId);
            }
          }
        }
        if (appSpecs && appSpecs === 'Application not found') {
          log.info(`id: ${record.taskId}, appname: ${record.appname}, hash: ${record.hash} removed from FluxDrive.`);
          const removeResult = await fluxDrive.removeFileVerified(record.hash);
          const removalError = getFluxDriveRemovalError(removeResult);
          if (removalError) {
            log.error(`Failed to remove expired-app task ${record.taskId}: ${removalError}`);
          } else {
            await dbCli.softRemoveTask(record.taskId);
          }
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Syncs apps with Syncthing to the automatic_backups table.
 * Adds new apps found and increments expire_count for apps no longer present.
 *
 * @async
 * @throws Will throw an error if the database query fails.
 */
async function syncSyncthingApps() {
  try {
    log.info('Syncing Syncthing apps with automatic_backups table...');

    const existingApps = await dbCli.execute(
      'SELECT appname, components, expire_counter, is_marketplace FROM automatic_backups',
    );
    const existingAppsByName = new Map(existingApps.map((app) => [app.appname, app]));
    const cacheRows = await dbCli.execute(`
      SELECT appname, spec_hash, has_syncthing, components, repotags
      FROM enterprise_app_discovery
    `);
    const cacheByName = enterpriseDiscoveryCache.normalizeCacheRows(cacheRows);
    const discovery = await fluxOS.discoverAppsWithSyncthing(cacheByName, existingAppsByName);

    if (!discovery) {
      log.error('Failed to fetch apps with Syncthing');
      return;
    }
    const syncthingApps = discovery.apps;

    for (let i = 0; i < discovery.cacheUpdates.length; i += 1) {
      const update = discovery.cacheUpdates[i];
      await dbCli.execute(`
        INSERT INTO enterprise_app_discovery (
          appname, spec_hash, has_syncthing, components, repotags, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          spec_hash = VALUES(spec_hash),
          has_syncthing = VALUES(has_syncthing),
          components = VALUES(components),
          repotags = VALUES(repotags),
          checked_at = VALUES(checked_at)
      `, [
        update.appname,
        update.specHash,
        Number(update.hasSyncthing),
        JSON.stringify(update.componentNames),
        JSON.stringify(update.repotags),
        Date.now(),
      ]);
    }

    const currentEnterpriseNames = discovery.currentEnterpriseAppNames.filter(Boolean);
    if (currentEnterpriseNames.length === 0) {
      await dbCli.execute('DELETE FROM enterprise_app_discovery');
    } else {
      const placeholders = currentEnterpriseNames.map(() => '?').join(', ');
      await dbCli.execute(
        `DELETE FROM enterprise_app_discovery WHERE appname NOT IN (${placeholders})`,
        currentEnterpriseNames,
      );
    }

    const marketplaceTemplates = await marketplaceService.getMarketplaceTemplates();
    const marketplaceClassificationAvailable = Array.isArray(marketplaceTemplates)
      && marketplaceTemplates.length > 0;
    if (!marketplaceClassificationAvailable) {
      log.warn('Marketplace classification unavailable; unchecked apps will be retried during the next sync');
    }

    // Check for new apps to add
    const newAppsToAdd = [];
    syncthingApps.forEach((app) => {
      if (!existingAppsByName.has(app.appName)) {
        newAppsToAdd.push(app);
      }
    });

    // Add new apps to the table
    for (let i = 0; i < newAppsToAdd.length; i += 1) {
      const app = newAppsToAdd[i];
      const componentsJson = JSON.stringify(app.componentNames);
      const isMarketplace = marketplaceClassificationAvailable
        ? Number(marketplaceService.matchesMarketplaceRepotags(app.repotags, marketplaceTemplates))
        : null;
      const query = `INSERT INTO automatic_backups (
        appname, components, status, expire_counter, last_backup_timestamp, is_marketplace
      ) VALUES (?, ?, 'pending', 0, 0, ?)`;
      await dbCli.execute(query, [app.appName, componentsJson, isMarketplace]);
      log.info(`Added new app ${app.appName} to automatic_backups (marketplace=${isMarketplace === null ? 'unchecked' : Boolean(isMarketplace)})`);
    }

    let classifiedExistingApps = 0;
    if (marketplaceClassificationAvailable) {
      for (let i = 0; i < syncthingApps.length; i += 1) {
        const app = syncthingApps[i];
        const existingApp = existingAppsByName.get(app.appName);
        if (existingApp) {
          const matchesMarketplace = marketplaceService.matchesMarketplaceRepotags(
            app.repotags,
            marketplaceTemplates,
          );
          const isMarketplace = marketplaceService.getMarketplaceClassificationUpdate(
            existingApp.is_marketplace,
            matchesMarketplace,
          );
          if (isMarketplace !== null) {
            await dbCli.execute(
              `UPDATE automatic_backups SET is_marketplace = ?
               WHERE appname = ? AND (is_marketplace IS NULL OR is_marketplace = 0)`,
              [isMarketplace, app.appName],
            );
            classifiedExistingApps += 1;
            log.info(`Classified existing app ${app.appName} as marketplace=${Boolean(isMarketplace)}`);
          }
        }
      }
    }

    // Check for expired apps (in DB but not in current syncthing list)
    const currentAppNames = new Set(syncthingApps.map((app) => app.appName));
    const expiredApps = [];
    existingAppsByName.forEach((existingApp, appName) => {
      if (!currentAppNames.has(appName)
        && !discovery.unresolvedEnterpriseAppNames.has(appName)) {
        expiredApps.push(appName);
      }
    });

    // Increment expire_counter for expired apps
    for (let i = 0; i < expiredApps.length; i += 1) {
      const appName = expiredApps[i];
      const query = 'UPDATE automatic_backups SET expire_counter = expire_counter + 1 WHERE appname = ?';
      await dbCli.execute(query, [appName]);
      log.info(`Incremented expire_counter for expired app ${appName}`);
    }

    log.info(`Sync complete. Added ${newAppsToAdd.length} new apps, classified ${classifiedExistingApps} existing apps, marked ${expiredApps.length} as expired.`);
  } catch (error) {
    log.error('Error syncing Syncthing apps:', error);
  }
}

/**
 * Checks if a given string is a valid URL.
 *
 * @param {string} string - The string to check.
 * @returns {boolean} - Returns true if the string is a valid URL, false otherwise.
 */
function isValidUrl(string) {
  try {
    // eslint-disable-next-line no-new
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * This function registers a backup task. It first extracts parameters from the request,
 * validates the user session, and checks the validity of the provided parameters.
 * It rejects files that can never fit within the user quota and checks for duplicates.
 * Existing automatic backups are pruned only after the new file has downloaded successfully.
 * If all checks pass, it adds the task to the database and runs the task if there is space in the queue.
 * If any step fails, it logs the error and sends an error message as the response.
 *
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @param {Object} taskObj - Optional task object containing all required variables (appname, component, timestamp, host, filesize, owner, filename, backup_type)
 * @throws Will throw an error if the user session is invalid, parameters are invalid, a file is larger than the user quota, the task is a duplicate, or database operation fails.
 */
async function registerBackupTask(req, res, taskObj = null) {
  let appname;
  let component;
  let filename;
  let timestamp;
  let host;
  let filesize;
  let owner;
  let backupType;

  // If taskObj is provided, use its values; otherwise extract from request
  if (taskObj) {
    ({
      appname, component, timestamp, host, filesize, owner, filename, backup_type: backupType,
    } = taskObj);
    // Default to 'manual' if not specified in taskObj
    backupType = backupType || 'manual';
  } else {
    ({ appname } = req.body);
    appname = appname || req.query.appname;
    ({ component } = req.body);
    component = component || req.query.component;
    ({ filename } = req.body);
    filename = filename || req.query.filename;
    ({ timestamp } = req.body);
    timestamp = timestamp || req.query.timestamp;
    ({ host } = req.body);
    host = host || req.query.host;
    ({ filesize } = req.body);
    filesize = filesize || req.query.filesize;
    // Manual backups from API requests default to 'manual'
    backupType = 'manual';
  }

  try {
    // validate session only if owner is not provided via taskObj
    if (!owner) {
      owner = await idService.verifyUserSession(req.headers);
      if (owner === false) {
        throw new Error('Unauthorized access. Session expired.');
      }
    }
    // validate app and component name
    if (!appname || !component) {
      throw new Error('Invalid app or component name.');
    }
    if (!await fluxOS.verifyAppOwner(owner, appname)) {
      throw new Error('Unauthorized. Access denied.');
    }
    // validate timestamp
    const numberpRegex = /^\d+$/;
    if (!numberpRegex.test(timestamp)) {
      throw new Error('timestamp is not valid');
    }
    // validate filename
    if (filename.length < 3 || filename.includes('/')) {
      throw new Error('filename is not valid');
    }
    // validate filesize
    if (!numberpRegex.test(filesize)) {
      throw new Error('filesize is not valid');
    }
    fileManager.validateFluxDriveFileSize({ filesize, host, filename });
    if (Number(filesize) > getQuotaLimitBytes()) {
      throw new Error('backup file is larger than the user quota.');
    }
    // validate host
    if (!isValidUrl(host)) {
      throw new Error('host url is not valid');
    }
    // get app expire height
    const appExpireHeight = await fluxOS.getAppExpireHeight(appname);
    if (appExpireHeight === false) {
      throw new Error("can't verify app specs, please try again");
    }
    // When taskObj is provided, extra can be empty
    const extra = taskObj ? '' : req.headers.zelidauth;
    // check if task is a duplicate (needed before quota check to avoid double-counting)
    const record = await dbCli.execute(`
      SELECT *
      FROM tasks
      WHERE owner = ?
      AND timestamp = ?
      AND appname = ?
      AND component = ?
      AND removedFromFluxdrive = 0
      AND (uploaded = 1 OR (uploaded = 0 AND finishTime = 0 AND fails < ?))
      ORDER BY taskId DESC
      LIMIT 1
    `, [owner, timestamp, appname, component, TASK_MAX_FAILURES]);
    if (record.length > 0 && record[0].uploaded === 1) {
      throw new Error('Checkpoint has already been uploaded to FluxDrive.');
    }
    let taskId = null;
    if (record.length > 0 && record[0].uploaded === 0) {
      // Resume existing task; return its ID even if the queue is full (updateQueue will retry)
      taskId = record[0].taskId;
      if (taskQueue.size < config.maxConcurrentTasks) {
        const task = await dbCli.getTask(taskId);
        if (task) {
          task.extra = taskObj ? '' : req.headers.zelidauth;
          task.removedFromFluxdrive = 0;
          await dbCli.updateTask(task);
          taskQueue.set(Number(taskId), task);
          launchTask(Number(taskId));
        }
      }
    } else {
      // add task to the db
      const newTask = {
        owner, timestamp, filename, appname, component, filesize, host, extra, appExpireHeight, backup_type: backupType,
      };
      const result = await dbCli.addNewTask(newTask);
      taskId = result.insertId;
      if (!taskId) {
        throw new Error('Failed to create backup task in database');
      }
      // run the task if there is space in queue
      if (taskQueue.size < config.maxConcurrentTasks) {
        const task = await dbCli.getTask(taskId);
        if (task) {
          taskQueue.set(Number(taskId), task);
          launchTask(Number(taskId));
        }
      }
    }
    const phraseResponse = messageHelper.createDataMessage({ taskId });
    res.json(phraseResponse);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * This function retrieves a list of backup tasks for a specific application.
 * It first extracts the application name from the request, validates the user session, and checks the validity of the application name.
 * If any step fails, it logs the error and sends an error message as the response.
 *
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @throws Will throw an error if the user session is invalid, application name is invalid, or database operation fails.
 */
async function getBackupList(req, res) {
  let { appname } = req.body;
  appname = appname || req.query.appname;
  const requestStartedAt = Date.now();
  const suppliedRequestId = String(req.headers['x-request-id'] || '');
  const requestId = /^[A-Za-z0-9._-]{1,80}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : `backup-list-${requestStartedAt}-${Math.random().toString(36).slice(2, 10)}`;
  let stage = 'session_validation';
  res.setHeader('X-Request-ID', requestId);
  log.info(`[getbackuplist:${requestId}] request started: app=${appname || 'missing'}`);

  try {
    // validate session
    const owner = await idService.verifyUserSession(req.headers);
    if (owner === false) {
      throw new Error('Unauthorized access. Session expired.');
    }
    // validate app and component name
    if (!appname) {
      throw new Error('Invalid appname.');
    }
    if (!await fluxOS.verifyAppOwner(owner, appname)) {
      throw new Error('Unauthorized. Access denied.');
    }
    stage = 'owner_resolution';

    // If owner is fluxteam, get the real app owner for backup retrieval
    let backupOwner = owner;
    if (await fluxOS.isTeamFluxId(owner)) {
      const realOwner = await fluxOS.getAppOwner(appname);
      if (realOwner) {
        backupOwner = realOwner;
        log.info(`Using real owner ${realOwner} for fluxteam backup retrieval of app ${appname}`);
      }
    }

    stage = 'database_query';
    const queryStartedAt = Date.now();
    log.info(`[getbackuplist:${requestId}] database query started: app=${appname}`);
    const result = await dbCli.getUserBackups(backupOwner, appname);
    const queryDurationMs = Date.now() - queryStartedAt;
    const resultCount = Array.isArray(result) ? result.length : 0;
    log.info(`[getbackuplist:${requestId}] database query completed: app=${appname}, rows=${resultCount}, durationMs=${queryDurationMs}`);
    stage = 'response_build';
    const checkpoints = [];
    if (Array.isArray(result)) {
      const temp = {};
      let i = 0;
      for (; i < result.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(temp, result[i].timestamp)) {
          temp[result[i].timestamp].components.push({ component: result[i].component, file_url: `https://jetpack2_38080.app.runonflux.io/ipfs/${result[i].hash}`, file_size: result[i].filesize });
        } else {
          if (i > 0) {
            checkpoints.push({ timestamp: result[i - 1].timestamp, components: temp[result[i - 1].timestamp].components });
          }
          temp[result[i].timestamp] = { components: [{ component: result[i].component, file_url: `https://jetpack2_38080.app.runonflux.io/ipfs/${result[i].hash}`, file_size: result[i].filesize }] };
        }
      }
      checkpoints.push({ timestamp: result[i - 1].timestamp, components: temp[result[i - 1].timestamp].components });
    }
    stage = 'response_send';
    res.json({ status: 'success', checkpoints });
    log.info(`[getbackuplist:${requestId}] response sent: app=${appname}, checkpoints=${checkpoints.length}, durationMs=${Date.now() - requestStartedAt}`);
  } catch (error) {
    log.error(`[getbackuplist:${requestId}] request failed: app=${appname || 'missing'}, stage=${stage}, durationMs=${Date.now() - requestStartedAt}, code=${error.code || 'unknown'}, message=${error.message}`);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    if (!res.headersSent) {
      res.json(errMessage);
    }
  }
}

/**
 * Returns task status.
 *
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @throws Will throw an error if the user session is invalid, taskId is invalid, or database operation fails.
 */
async function getTaskStatus(req, res) {
  let { taskId } = req.body;
  taskId = taskId || req.query.taskId;

  try {
    // validate session
    const owner = await idService.verifyUserSession(req.headers);
    if (owner === false) {
      throw new Error('Unauthorized access. Session expired.');
    }
    // validate app and component name
    if (!taskId) {
      throw new Error('taskId not provided.');
    }
    console.log(taskQueue.entries());
    let task = taskQueue.get(Number(taskId));
    if (!task) {
      task = await dbCli.getTask(taskId);
    }

    if (!task) {
      throw new Error('task does not exist.');
    }
    res.json({ status: 'success', data: { taskId: task.taskId, status: task.status } });
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * Removes the provided checkpoint and it's files stored on FluxDrive.
 *
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @throws Will throw an error if the user session is invalid, taskId is invalid, or database operation fails.
 */
async function removeCheckpoint(req, res) {
  let { timestamp } = req.body;
  timestamp = timestamp || req.query.timestamp;
  let { appname } = req.body;
  appname = appname || req.query.appname;

  try {
    // validate session
    const owner = await idService.verifyUserSession(req.headers);
    if (owner === false) {
      throw new Error('Unauthorized access. Session expired.');
    }
    // validate timestamp
    if (!timestamp) {
      throw new Error('timestamp not provided.');
    }

    // validate appname
    if (!appname) {
      throw new Error('appname not provided.');
    }
    if (!await fluxOS.verifyAppOwner(owner, appname)) {
      throw new Error('Unauthorized. Access denied.');
    }
    const checkpoint = await dbCli.getUserCheckpoint(owner, appname, timestamp);

    if (!checkpoint) {
      throw new Error('checkpoint does not exist.');
    }
    const removedFiles = [];
    if (Array.isArray(checkpoint)) {
      for (let i = 0; i < checkpoint.length; i += 1) {
        if (checkpoint[i].hash) {
          // eslint-disable-next-line no-await-in-loop
          const removeResult = await fluxDrive.removeFileVerified(checkpoint[i].hash);
          const removalError = getFluxDriveRemovalError(removeResult);
          if (removalError) {
            log.error(`Failed to remove checkpoint task ${checkpoint[i].taskId}: ${removalError}`);
            // eslint-disable-next-line no-continue
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          await dbCli.softRemoveTask(checkpoint[i].taskId);
          removedFiles.push({
            timestamp: checkpoint[i].timestamp, hash: checkpoint[i].hash, filename: checkpoint[i].filename, filesize: checkpoint[i].filesize,
          });
        }
      }
    }
    if (removedFiles.length) {
      res.json({ status: 'success', data: { removedFiles } });
    } else {
      res.json({ status: 'error', data: { message: 'No file removed' } });
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * Waits for all backup tasks to complete successfully.
 *
 * @async
 * @param {Array<number>} taskIds - Array of task IDs to monitor
 * @param {number} timeoutMinutes - Timeout in minutes (default: 60)
 * @returns {Promise<{success: boolean, failures: Array<Object>}>}
 */
async function waitForTasksToComplete(taskIds, timeoutMinutes = 60) {
  if (!taskIds || taskIds.length === 0) {
    log.info('No tasks to wait for');
    return { success: true, failures: [] };
  }

  const startTime = Date.now();
  const timeout = timeoutMinutes * 60 * 1000;
  const checkInterval = 30000; // Check every 30 seconds

  log.info(`Waiting for ${taskIds.length} tasks to complete: ${taskIds.join(', ')}`);

  while (Date.now() - startTime < timeout) {
    let hasPendingTasks = false;
    const failures = [];

    for (let i = 0; i < taskIds.length; i += 1) {
      const taskId = taskIds[i];
      const task = await dbCli.getTask(taskId);
      const outcome = getTaskOutcome(task);

      if (outcome.state === 'pending') {
        hasPendingTasks = true;
        // eslint-disable-next-line no-continue
        continue;
      }

      if (outcome.state === 'failed') {
        failures.push(buildTaskFailure(task, taskId, outcome.reason));
        log.error(`Task ${taskId} failed: ${outcome.reason}`);
      }
    }

    if (!hasPendingTasks && failures.length > 0) {
      log.error('Some tasks failed after all component tasks settled.');
      return { success: false, failures };
    }

    if (!hasPendingTasks) {
      log.info('All tasks completed successfully');
      return { success: true, failures: [] };
    }

    log.debug(`Still waiting for tasks to complete... (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`);
    await new Promise((resolve) => { setTimeout(resolve, checkInterval); });
  }

  const timeoutReason = `Timeout waiting for tasks to complete after ${timeoutMinutes} minutes`;
  log.error(timeoutReason);
  return {
    success: false,
    failures: await collectTaskFailures(taskIds, timeoutReason),
  };
}

/**
 * Removes artifacts created by a new automatic-backup batch that did not complete.
 * Only terminal tasks are touched so an in-flight upload cannot race with cleanup.
 *
 * @param {Array<number>} taskIds - Task IDs belonging to the incomplete batch
 * @returns {Promise<Object>} - Cleanup counts
 */
async function cleanupIncompleteAutomaticBackupTasks(taskIds) {
  let removed = 0;
  let failed = 0;
  let inProgress = 0;

  for (let i = 0; i < taskIds.length; i += 1) {
    const taskId = taskIds[i];
    const task = await dbCli.getTask(taskId);

    if (!task) {
      failed += 1;
      // eslint-disable-next-line no-continue
      continue;
    }

    const isTerminal = task.finishTime > 0 || task.fails >= TASK_MAX_FAILURES;
    if (!isTerminal) {
      inProgress += 1;
      // eslint-disable-next-line no-continue
      continue;
    }

    await dbCli.execute(
      'UPDATE tasks SET backup_type = ? WHERE taskId = ?',
      ['automatic_failed', taskId],
    );

    let artifactCleanupFailed = false;

    if (task.host && !task.remoteRemoved) {
      // eslint-disable-next-line no-use-before-define
      const remoteRemoved = await removeBackupFromRemoteHost(task.host, taskId);
      if (!remoteRemoved) {
        artifactCleanupFailed = true;
        failed += 1;
      }
    }

    if (task.fails >= TASK_MAX_FAILURES && !task.localRemoved) {
      try {
        await fileManager.deleteFile(task);
        await dbCli.execute('UPDATE tasks SET localRemoved = 1 WHERE taskId = ?', [taskId]);
      } catch (error) {
        log.error(`Failed to remove local file for incomplete task ${taskId}:`, error.message);
        artifactCleanupFailed = true;
        failed += 1;
      }
    }

    if (task.uploaded === 1) {
      if (!task.hash) {
        log.warn(`Incomplete automatic backup task ${taskId} has no FluxDrive hash`);
        failed += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      const removeResult = await fluxDrive.removeFileVerified(task.hash);
      const removalError = getFluxDriveRemovalError(removeResult);
      if (removalError) {
        log.error(`Failed to roll back incomplete automatic backup task ${taskId}: ${removalError}`);
        failed += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      await dbCli.softRemoveTask(taskId);
      removed += 1;
    } else if (!artifactCleanupFailed) {
      await dbCli.softRemoveTask(taskId);
      removed += 1;
    }
  }

  return { removed, failed, inProgress };
}

/**
 * Periodically cleans up terminal automatic tasks.
 * Includes legacy failed tasks that were never reclassified as automatic_failed.
 * Successful backup retention is quota-driven during the upload path.
 *
 * @async
 * @returns {Promise<Object>} - Summary of cleanup results
 */
async function cleanupOldAutomaticBackups() {
  try {
    log.info('Running periodic cleanup for incomplete automatic backups...');

    const incompleteTasks = await dbCli.execute(`
      SELECT taskId
      FROM tasks
      WHERE (
        backup_type = 'automatic_failed'
        OR (
          backup_type = 'automatic'
          AND uploaded = 0
          AND (finishTime > 0 OR fails >= ?)
        )
      )
      AND (
        removedFromFluxdrive = 0
        OR remoteRemoved = 0
        OR (fails >= ? AND localRemoved = 0)
      )
    `, [TASK_MAX_FAILURES, TASK_MAX_FAILURES]);
    const incompleteResult = await cleanupIncompleteAutomaticBackupTasks(
      incompleteTasks.map((task) => task.taskId),
    );

    log.info(`Incomplete automatic backup cleanup summary: ${incompleteResult.removed} removed, ${incompleteResult.failed} failed, ${incompleteResult.inProgress} still in progress`);
    return {
      totalRemoved: incompleteResult.removed,
      totalFailed: incompleteResult.failed,
      appsProcessed: 0,
    };
  } catch (error) {
    log.error('Error in cleanupOldAutomaticBackups:', error.message);
    return { totalRemoved: 0, totalFailed: 0, appsProcessed: 0 };
  }
}

function findTasksChangedByLegacyReconciliation() {
  const reconciledTasks = new Map();
  const logsDirectory = path.join(__dirname, '../../logs');
  const filenames = ['debug.log', 'info.log', 'error.log'];

  for (let i = 0; i < filenames.length; i += 1) {
    const logPath = path.join(logsDirectory, filenames[i]);
    if (fs.existsSync(logPath)) {
      const extracted = extractReconciledTasks(fs.readFileSync(logPath, 'utf8'));
      extracted.forEach((hash, taskId) => reconciledTasks.set(taskId, hash));
    }
  }

  return reconciledTasks;
}

async function isHashRetrievable(hash) {
  const gateway = config.ipfsGatewayUrl.replace(/\/+$/, '');
  try {
    const response = await axios.get(`${gateway}/${encodeURIComponent(hash)}`, {
      headers: { Range: 'bytes=0-0' },
      responseType: 'stream',
      timeout: 30000,
      validateStatus: () => true,
    });
    if (response.data && typeof response.data.destroy === 'function') {
      response.data.destroy();
    }
    return response.status === 200 || response.status === 206;
  } catch (error) {
    log.warn(`Could not directly verify reconciled hash ${hash}: ${getErrorMessage(error)}`);
    return false;
  }
}

/**
 * Repairs records changed by the retired inventory reconciliation.
 *
 * The FluxDrive /ls endpoint is capped and is never used as proof of absence.
 * Only task IDs recorded by the old reconciler are considered, their exact hash
 * must be directly retrievable, and each row can be recovered only once.
 *
 * @async
 * @returns {Promise<Object>} - Recovery summary
 */
async function reconcileFluxDriveInventory() {
  if (fluxDriveReconciliationRunning) {
    log.warn('FluxDrive reconciliation recovery is already running');
    return {
      candidates: 0, recovered: 0, unavailable: 0, skipped: true,
    };
  }

  fluxDriveReconciliationRunning = true;
  try {
    const loggedTasks = findTasksChangedByLegacyReconciliation();
    if (loggedTasks.size === 0) {
      log.info('No records from the retired FluxDrive inventory reconciliation require recovery');
      return {
        candidates: 0, recovered: 0, unavailable: 0, skipped: false,
      };
    }

    const loggedTaskIds = [...loggedTasks.keys()];
    const candidates = [];
    for (let offset = 0; offset < loggedTaskIds.length; offset += 100) {
      const taskIds = loggedTaskIds.slice(offset, offset + 100);
      const placeholders = taskIds.map(() => '?').join(',');
      const rows = await dbCli.execute(`
        SELECT taskId, hash, appname, component, status, uploaded,
          removedFromFluxdrive, reconciliationRecovered
        FROM tasks
        WHERE taskId IN (${placeholders})
        AND uploaded = 0
        AND removedFromFluxdrive = 1
        AND reconciliationRecovered = 0
      `, taskIds);
      if (!Array.isArray(rows)) {
        throw new Error('Could not load tasks changed by the retired reconciliation');
      }
      for (let i = 0; i < rows.length; i += 1) candidates.push(rows[i]);
    }

    let recovered = 0;
    let unavailable = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const task = candidates[i];
      const expectedHash = loggedTasks.get(Number(task.taskId));
      if (isRecoverableTask(task, expectedHash)) {
        if (!await isHashRetrievable(task.hash)) {
          unavailable += 1;
          log.warn(`Legacy reconciliation recovery deferred for task ${task.taskId}: hash ${task.hash} is not directly retrievable`);
        } else {
          const updateResult = await dbCli.execute(`
            UPDATE tasks
            SET uploaded = 1,
              removedFromFluxdrive = 0,
              reconciliationRecovered = 1
            WHERE taskId = ?
            AND hash = ?
            AND uploaded = 0
            AND removedFromFluxdrive = 1
            AND reconciliationRecovered = 0
          `, [task.taskId, task.hash]);
          if (updateResult?.affectedRows !== 1) {
            throw new Error(`Could not recover wrongly reconciled task ${task.taskId}`);
          }
          recovered += 1;
          log.info(`Recovered task ${task.taskId}: directly verified hash ${task.hash} and restored FluxDrive visibility`);
        }
      }
    }

    log.info(`FluxDrive reconciliation recovery summary: candidates=${candidates.length}, recovered=${recovered}, unavailable=${unavailable}`);
    return {
      candidates: candidates.length,
      recovered,
      unavailable,
      skipped: false,
    };
  } catch (error) {
    log.error(`FluxDrive reconciliation recovery failed: ${getErrorMessage(error)}`);
    return {
      candidates: 0, recovered: 0, unavailable: 0, skipped: true,
    };
  } finally {
    fluxDriveReconciliationRunning = false;
  }
}

/**
 * Removes backup file from remote host
 * Converts the download URL to removal URL and sends request with team authentication
 * @async
 * @param {string} host - The host URL from task (download URL)
 * @param {number} taskId - The task ID for updating database
 * @returns {Promise<boolean>} - true if removal was successful, false otherwise
 */
async function removeBackupFromRemoteHost(host, taskId) {
  try {
    // Convert download URL to removal URL
    // From: http://99.132.138.126:16177/backup/downloadlocalfile/...
    // To:   http://99.132.138.126:16177/backup/removebackupfile/...
    const removalUrl = host.replace('/backup/downloadlocalfile/', '/backup/removebackupfile/');

    log.info(`Attempting to remove remote file for task ${taskId} from: ${removalUrl}`);

    // Parse URL to get node address
    const urlParts = new URL(removalUrl);
    const nodeUrl = `${urlParts.protocol}//${urlParts.host}`;

    // Get zelidAuth for the request
    const zelidAuth = await fluxOS.verifyTeamLogin(nodeUrl);

    if (!zelidAuth) {
      log.error(`Failed to authenticate with node for task ${taskId}`);
      return false;
    }

    // Make the removal request using axios
    const response = await axios.get(removalUrl, {
      headers: {
        zelidauth: zelidAuth,
      },
      timeout: 30000, // 30 second timeout
    });

    // Check if removal was successful
    if (response.data && response.data.status === 'success') {
      log.info(`Successfully removed remote file for task ${taskId}`);

      // Update the task to mark remoteRemoved as 1
      await dbCli.execute('UPDATE tasks SET remoteRemoved = 1 WHERE taskId = ?', [taskId]);

      return true;
    }

    log.error(`Failed to remove remote file for task ${taskId}. Response:`, response.data);
    return false;
  } catch (error) {
    log.error(`Error removing remote file for task ${taskId}:`, error.message);
    return false;
  }
}

/**
 * Processes automatic backups by fetching the next scheduled backup from the database,
 * creating backup tasks on the node, and registering them for processing.
 *
 * @async
 * @returns {Promise<boolean>} - Returns true if successful, false if failed
 */
async function claimNextAutomaticBackup(database, now, requestedToken = null) {
  const standardIntervalMs = config.automaticBackupSchedule.standardIntervalHours
    * 60 * 60 * 1000;
  const marketplaceIntervalMs = config.automaticBackupSchedule.marketplaceIntervalHours
    * 60 * 60 * 1000;
  const standardCutoff = now - standardIntervalMs;
  const marketplaceCutoff = now - marketplaceIntervalMs;
  const candidates = await database.execute(
    `SELECT *
     FROM automatic_backups
     WHERE status != ?
     AND (dispatch_lease_until = 0 OR dispatch_lease_until < ?)
     AND (
       (
         status = 'pending' AND dispatch_token IS NOT NULL
         AND dispatch_lease_until > 0 AND dispatch_lease_until < ?
       )
       OR (is_marketplace = 1 AND last_backup_timestamp < ?)
       OR ((is_marketplace = 0 OR is_marketplace IS NULL) AND last_backup_timestamp < ?)
     )
     ORDER BY
       CASE WHEN status = 'pending' AND dispatch_token IS NOT NULL
         AND dispatch_lease_until > 0 AND dispatch_lease_until < ? THEN 0 ELSE 1 END ASC,
       CASE
         WHEN is_marketplace = 1 THEN last_backup_timestamp + ?
         ELSE last_backup_timestamp + ?
       END ASC
     LIMIT 1`,
    [
      'cancelled',
      now,
      now,
      marketplaceCutoff,
      standardCutoff,
      now,
      marketplaceIntervalMs,
      standardIntervalMs,
    ],
  );
  if (candidates.length === 0) return null;

  const candidate = candidates[0];
  const reclaimingStaleLease = candidate.status === 'pending'
    && Boolean(candidate.dispatch_token)
    && Number(candidate.dispatch_lease_until) > 0
    && Number(candidate.dispatch_lease_until) < now;
  const dispatchToken = requestedToken || crypto.randomBytes(16).toString('hex');
  const leaseUntil = now + (
    config.automaticBackupSchedule.dispatcherLeaseMinutes * 60 * 1000
  );
  try {
    const claim = await database.execute(`
      UPDATE automatic_backups
      SET dispatch_token = ?, dispatch_lease_until = ?,
        last_backup_timestamp = ?, status = 'pending'
      WHERE id = ? AND last_backup_timestamp = ? AND status != 'cancelled'
      AND (dispatch_lease_until = 0 OR dispatch_lease_until < ?)
    `, [
      dispatchToken,
      leaseUntil,
      now,
      candidate.id,
      candidate.last_backup_timestamp,
      now,
    ]);
    if (claim.affectedRows !== 1) {
      log.info(`Automatic backup claim lost for ${candidate.appname}; another dispatcher claimed it`);
      return null;
    }
    if (reclaimingStaleLease) {
      log.warn(`Reclaimed expired automatic backup dispatch for ${candidate.appname}; previous lease expired at ${new Date(Number(candidate.dispatch_lease_until)).toISOString()}`);
    }
  } catch (error) {
    log.error(`Automatic backup claim update failed for ${candidate.appname}: ${getErrorMessage(error)}`);
    try {
      const confirmation = await database.execute(
        'SELECT id FROM automatic_backups WHERE id = ? AND dispatch_token = ?',
        [candidate.id, dispatchToken],
      );
      if (confirmation.length === 0) throw error;
      log.warn(`Automatic backup claim for ${candidate.appname} succeeded despite a timed-out acknowledgement`);
    } catch (confirmationError) {
      log.error(`Could not confirm automatic backup claim for ${candidate.appname}; skipping without Discord notification: ${getErrorMessage(confirmationError)}`);
      return null;
    }
  }

  return {
    ...candidate,
    dispatch_token: dispatchToken,
    dispatch_lease_until: leaseUntil,
    last_backup_timestamp: now,
    status: candidate.status,
    reclaimed_stale_lease: reclaimingStaleLease,
  };
}

function parseBackupTaskIds(storedTaskIds) {
  let parsed = storedTaskIds;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      return null;
    }
  }
  return Array.isArray(parsed) ? parsed.map(Number) : null;
}

function backupTaskIdsMatch(storedTaskIds, expectedTaskIds) {
  const parsed = parseBackupTaskIds(storedTaskIds);
  if (!parsed || parsed.length !== expectedTaskIds.length) return false;
  return parsed.every((taskId, index) => Number(taskId) === Number(expectedTaskIds[index]));
}

async function persistAutomaticBackupCompletion(
  database,
  automaticBackup,
  taskIds,
  retryDelayMs = 1000,
) {
  const backupTasksJson = JSON.stringify(taskIds);
  let updateError = null;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await database.execute(
        `UPDATE automatic_backups SET backup_tasks = ?, status = ?,
          dispatch_token = NULL, dispatch_lease_until = 0,
          last_failure_fingerprint = NULL, last_failure_notified_at = 0
         WHERE id = ? AND dispatch_token = ?`,
        [backupTasksJson, 'done', automaticBackup.id, automaticBackup.dispatch_token],
      );
      if (result.affectedRows === 1) {
        return { canonicalTaskIds: taskIds, duplicateTaskIds: [] };
      }
      updateError = new Error(
        `Dispatch token no longer matched while marking ${automaticBackup.appname} as completed`,
      );
    } catch (error) {
      updateError = error;
    }

    try {
      const rows = await database.execute(
        `SELECT status, backup_tasks, dispatch_token, last_backup_timestamp
         FROM automatic_backups WHERE id = ?`,
        [automaticBackup.id],
      );
      const stored = rows[0];
      const storedTaskIds = parseBackupTaskIds(stored?.backup_tasks);
      const sameDispatch = Number(stored?.last_backup_timestamp)
        === Number(automaticBackup.last_backup_timestamp);

      if (stored?.status === 'done' && !stored.dispatch_token) {
        if (backupTaskIdsMatch(stored.backup_tasks, taskIds)) {
          log.warn(`Automatic backup completion for ${automaticBackup.appname} was confirmed after an ambiguous database response`);
          return { canonicalTaskIds: taskIds, duplicateTaskIds: [] };
        }
        if (sameDispatch && storedTaskIds) {
          log.warn(`Automatic backup ${automaticBackup.appname} was already completed by an earlier attempt in the same dispatch; keeping tasks ${storedTaskIds.join(', ')} and rolling back duplicates ${taskIds.join(', ')}`);
          return { canonicalTaskIds: storedTaskIds, duplicateTaskIds: taskIds };
        }
      }

      if (stored && stored.dispatch_token !== automaticBackup.dispatch_token) {
        updateError = new Error(
          `Dispatch ownership changed before ${automaticBackup.appname} could be marked completed`,
        );
        break;
      }
    } catch (confirmationError) {
      log.error(`Could not confirm automatic backup completion for ${automaticBackup.appname} (attempt ${attempt}/${maxAttempts}): ${getErrorMessage(confirmationError)}`);
    }

    if (attempt < maxAttempts && retryDelayMs > 0) {
      await new Promise((resolve) => { setTimeout(resolve, retryDelayMs); });
    }
  }

  const reason = `Backup files uploaded, but completion could not be confirmed for ${automaticBackup.appname}: ${getErrorMessage(updateError)}`;
  throw createBackupFailure(reason, 'completion_persistence', [], [{
    check: 'Persist automatic backup completion',
    outcome: 'failed',
    errorCode: updateError?.code || null,
    detail: getErrorMessage(updateError),
  }]);
}

async function processAutomaticBackupInternal() {
  const maxRetries = 3;
  let retryCount = 0;
  let automaticBackup = null;
  let lastFailure = null;
  const failureAttempts = [];
  const attemptedNodes = new Set();
  let automaticRunStartedAt = null;
  let automaticRunBatchKey = null;

  try {
    const now = Date.now();
    automaticBackup = await claimNextAutomaticBackup(dbCli, now);
    if (!automaticBackup) {
      log.info('No automatic backups to process');
      return false;
    }

    const {
      id, appname, components, is_marketplace: isMarketplace,
    } = automaticBackup;
    automaticRunStartedAt = Date.now();
    const scheduleHours = Number(isMarketplace) === 1
      ? config.automaticBackupSchedule.marketplaceIntervalHours
      : config.automaticBackupSchedule.standardIntervalHours;

    const isExpired = await fluxOS.isAppExpiredInGlobalSpecs(appname);
    if (isExpired === true) {
      log.info(`Automatic backup cancelled for ${appname}: app is expired`);
      await dbCli.execute(
        `UPDATE automatic_backups SET status = ?, last_backup_timestamp = ?,
          expire_counter = expire_counter + 1, dispatch_token = NULL,
          dispatch_lease_until = 0 WHERE id = ? AND dispatch_token = ?`,
        ['cancelled', Date.now(), id, automaticBackup.dispatch_token],
      );
      return false;
    }
    if (isExpired === null) {
      log.warn(`Could not verify expiration status for ${appname}, proceeding with backup`);
    }

    // Handle components - MySQL might return it as already parsed array or as JSON string
    let componentList;

    if (Array.isArray(components)) {
      // Already an array (MySQL JSON column auto-parsed)
      componentList = components;
    } else if (typeof components === 'string') {
      // It's a string, try to parse it
      try {
        componentList = JSON.parse(components);
      } catch (jsonError) {
        // If JSON parsing fails, treat as comma-separated string
        log.info(`Components field is not valid JSON for ${appname}, treating as comma-separated string`);
        componentList = components.split(',').map((comp) => comp.trim()).filter((comp) => comp);
      }
    } else if (typeof components === 'object' && components !== null) {
      // It's an object but not an array, convert to array
      componentList = [components];
    } else {
      // Fallback to empty array
      log.error(`Unexpected components format for ${appname}:`, components);
      componentList = [];
    }

    // Final validation - ensure it's an array
    if (!Array.isArray(componentList)) {
      componentList = [];
    }

    if (automaticBackup.status === 'failing') {
      log.info(`Retrying automatic backup for ${appname} after previous failure (${scheduleHours}-hour window elapsed)`);
    }

    log.info(`Processing automatic backup for app: ${appname} (marketplace=${Number(isMarketplace) === 1}, intervalHours=${scheduleHours})`);

    // Retry loop for node operations
    while (retryCount < maxRetries) {
      const attemptDiagnostics = [];
      try {
        // Get secondary node from HAProxy
        const nodeSelection = await fluxOS.getSecondaryNodeSelection(appname, attemptedNodes);
        attemptDiagnostics.push(...nodeSelection.diagnostics);
        const nodeAddress = nodeSelection.node;
        if (!nodeAddress) {
          throw createBackupFailure(
            nodeSelection.reason || `Failed to get secondary node for ${appname}`,
            'node_selection',
            [],
            attemptDiagnostics,
          );
        }

        const node = `http://${nodeAddress}`;
        attemptedNodes.add(nodeAddress);
        log.info(`Using node: ${node}`);

        // Get zelidAuth from node
        const loginResult = await fluxOS.verifyTeamLoginDetailed(node);
        attemptDiagnostics.push(...loginResult.diagnostics);

        if (!loginResult.zelidAuth) {
          throw createBackupFailure(
            loginResult.reason || `Failed to authenticate with ${node}`,
            'node_auth',
            [],
            attemptDiagnostics,
          );
        }
        const { zelidAuth } = loginResult;

        // Get app owner
        const ownerResult = await fluxOS.getAppOwnerDetailed(appname);
        attemptDiagnostics.push(...ownerResult.diagnostics);
        if (!ownerResult.owner) {
          throw createBackupFailure(
            `Failed to get app owner for ${appname}`,
            'app_owner',
            [],
            attemptDiagnostics,
          );
        }
        const { owner } = ownerResult;

        // Create backup task on node
        const backupResult = await fluxOS.createBackupTaskOnNode(node, zelidAuth, appname, componentList);
        attemptDiagnostics.push(...(backupResult?.diagnostics || []));
        if (!backupResult || backupResult.status === 'failed' || !backupResult.components) {
          throw createBackupFailure(
            backupResult?.error || `Failed to create backup tasks on ${node}`,
            'create_backup',
            [],
            attemptDiagnostics,
          );
        }

        log.info(`Created backup tasks for ${backupResult.totalComponents} components`);

        // Register backup tasks for each component
        const taskIds = [];
        const registrationFailures = [];
        // eslint-disable-next-line no-restricted-syntax
        let backupTimestamp = 0;
        // eslint-disable-next-line no-restricted-syntax
        for (const componentData of backupResult.components) {
          if (componentData.backups && componentData.host) {
            if (backupTimestamp === 0) backupTimestamp = componentData.backups.create;
            const taskObj = {
              appname,
              component: componentData.component,
              timestamp: backupTimestamp,
              host: componentData.host,
              filesize: componentData.backups.size,
              owner,
              filename: componentData.backups.name,
              backup_type: 'automatic',
            };

            try {
              const mockReq = { body: {}, query: {}, headers: {} };
              const { mockRes, getTaskId, getError } = createRegistrationMocks();

              await registerBackupTask(mockReq, mockRes, taskObj);
              const taskId = getTaskId();
              if (taskId) {
                taskIds.push(taskId);
                log.info(`Registered task ${taskId} for component ${componentData.component}`);
              } else {
                const registrationError = getError();
                log.error(`Failed to queue backup for component ${componentData.component}:`, registrationError);
                registrationFailures.push({
                  taskId: null,
                  component: componentData.component,
                  message: registrationError,
                  fails: 0,
                });
              }
            } catch (error) {
              log.error(`Failed to register task for component ${componentData.component}:`, error);
              registrationFailures.push({
                taskId: null,
                component: componentData.component,
                message: getErrorMessage(error),
                fails: 0,
              });
            }
          } else {
            registrationFailures.push({
              taskId: null,
              component: componentData.component,
              message: componentData.error || 'Backup file was not found on the Flux node after creation',
              fails: 0,
            });
          }
        }

        if (backupTimestamp) {
          automaticRunBatchKey = `automatic:${appname}:${backupTimestamp}`;
        }

        registrationFailures.forEach((failure) => {
          attemptDiagnostics.push({
            check: `Backup registration (${failure.component})`,
            outcome: 'failed',
            node,
            detail: failure.message,
          });
        });

        if (taskIds.length === 0) {
          throw createBackupFailure(
            summarizeRegistrationFailures(registrationFailures),
            'create_backup',
            registrationFailures,
            attemptDiagnostics,
          );
        }

        if (registrationFailures.length > 0) {
          await waitForTasksToComplete(taskIds, 60);
          const rollbackResult = await cleanupIncompleteAutomaticBackupTasks(taskIds);
          log.info(`Incomplete batch rollback: ${rollbackResult.removed} task artifacts removed, ${rollbackResult.failed} cleanup failures`);
          throw createBackupFailure(
            summarizeRegistrationFailures(registrationFailures),
            'task_pipeline',
            registrationFailures,
            attemptDiagnostics,
          );
        }

        // Wait for all new backup tasks to complete successfully
        log.info(`Waiting for ${taskIds.length} new automatic backup tasks to complete...`);
        const waitResult = await waitForTasksToComplete(taskIds, 60);

        if (waitResult.success) {
          log.info('All new automatic backup tasks completed successfully. Proceeding with cleanup...');

          // Remove backup files from remote hosts
          log.info(`Removing backup files from remote hosts for ${taskIds.length} tasks...`);
          let remoteRemovalCount = 0;
          // Using traditional for loop to avoid ESLint no-restricted-syntax error
          for (let i = 0; i < taskIds.length; i += 1) {
            const taskId = taskIds[i];
            // Get task details to get the host URL
            // eslint-disable-next-line no-await-in-loop
            const taskDetails = await dbCli.execute('SELECT host FROM tasks WHERE taskId = ?', [taskId]);
            if (taskDetails.length > 0 && taskDetails[0].host) {
              // eslint-disable-next-line no-await-in-loop
              const removalSuccess = await removeBackupFromRemoteHost(taskDetails[0].host, taskId);
              if (removalSuccess) {
                remoteRemovalCount += 1;
              }
            }
          }
          log.info(`Remote file removal complete: ${remoteRemovalCount}/${taskIds.length} files removed from nodes`);

          // Update automatic_backups record with new task IDs and set status to 'done'
          const completionResult = await persistAutomaticBackupCompletion(
            dbCli,
            automaticBackup,
            taskIds,
          );
          const completedTaskIds = completionResult.canonicalTaskIds;

          if (completionResult.duplicateTaskIds.length > 0) {
            try {
              const duplicateCleanup = await cleanupIncompleteAutomaticBackupTasks(
                completionResult.duplicateTaskIds,
              );
              log.warn(`Duplicate automatic backup rollback for ${appname}: ${duplicateCleanup.removed} removed, ${duplicateCleanup.failed} failed, ${duplicateCleanup.inProgress} still in progress`);
            } catch (cleanupError) {
              log.error(`Could not roll back duplicate automatic tasks for ${appname}; periodic cleanup will retry: ${getErrorMessage(cleanupError)}`);
            }
          }

          let completedStats = null;
          try {
            [completedStats] = await dbCli.execute(
              `SELECT COUNT(*) AS file_count, COALESCE(SUM(filesize), 0) AS total_size
               FROM tasks WHERE taskId IN (${completedTaskIds.map(() => '?').join(', ')})`,
              completedTaskIds,
            );
          } catch (statsError) {
            log.error(`Automatic backup ${appname} is complete, but its activity statistics could not be loaded: ${getErrorMessage(statsError)}`);
          }
          await recordAutomaticRunActivity({
            automaticBackup,
            runStartedAt: automaticRunStartedAt,
            batchKey: automaticRunBatchKey,
            outcome: 'success',
            fileCount: Number(completedStats?.file_count) || completedTaskIds.length,
            filesize: Number(completedStats?.total_size) || 0,
            stage: 'completed',
            reason: 'All component tasks completed successfully',
          });

          log.info(`Successfully processed automatic backup for ${appname}. Stored ${completedTaskIds.length} canonical tasks.`);
          return true;
        }

        const taskFailureSummary = waitResult.failures
          .map((failure) => `${failure.component}: ${failure.message}`)
          .join('; ');
        const rollbackResult = await cleanupIncompleteAutomaticBackupTasks(taskIds);
        waitResult.failures.forEach((failure) => {
          attemptDiagnostics.push({
            check: failure.check || `Component pipeline (${failure.component})`,
            outcome: 'failed',
            node: failure.node || node,
            endpoint: failure.endpoint || null,
            httpStatus: failure.httpStatus || null,
            errorCode: failure.errorCode || null,
            fileSize: failure.fileSize || 0,
            receivedSize: failure.receivedSize,
            responseBody: failure.responseBody || null,
            detail: failure.message,
          });
        });
        log.error(
          `New backup batch failed. Rolled back ${rollbackResult.removed} component artifacts; ${rollbackResult.failed} cleanup operations failed.`,
          taskFailureSummary,
        );
        throw createBackupFailure(
          taskFailureSummary || 'New backup tasks failed to complete',
          'task_pipeline',
          waitResult.failures,
          attemptDiagnostics,
        );
      } catch (error) {
        retryCount += 1;
        lastFailure = {
          stage: inferFailureStage(error),
          reason: getErrorMessage(error),
          taskFailures: error.taskFailures || [],
          diagnostics: error.diagnostics || attemptDiagnostics,
        };
        failureAttempts.push({
          attempt: retryCount,
          ...lastFailure,
        });
        if (lastFailure.stage === 'task_pipeline') {
          log.error(`Automatic backup ${appname} failed after component-level retries:`, lastFailure.reason);
          break;
        }
        if (lastFailure.stage === 'completion_persistence') {
          log.error(`Automatic backup ${appname} will not recreate uploaded files because completion is unconfirmed:`, lastFailure.reason);
          break;
        }

        log.error(`Attempt ${retryCount}/${maxRetries} failed for automatic backup ${appname}:`, lastFailure.reason);

        if (retryCount < maxRetries) {
          log.info('Waiting 20 seconds before retry...');
          await new Promise((resolve) => { setTimeout(resolve, 20000); });
        }
      }
    }

    let failureStatusPersisted = true;
    // Preserve the actual backup failure if persisting the final status also times out.
    try {
      await dbCli.execute(
        `UPDATE automatic_backups SET status = ?, dispatch_token = NULL,
          dispatch_lease_until = 0 WHERE id = ? AND dispatch_token = ?`,
        ['failing', id, automaticBackup.dispatch_token],
      );
    } catch (statusError) {
      failureStatusPersisted = false;
      log.error(`Failed to persist automatic backup failure status for ${appname}: ${getErrorMessage(statusError)}`);
      lastFailure.diagnostics = [
        ...(lastFailure.diagnostics || []),
        {
          check: 'Persist automatic backup failure status',
          outcome: 'failed',
          errorCode: statusError.code || null,
          detail: getErrorMessage(statusError),
        },
      ];
      if (failureAttempts.length > 0) {
        failureAttempts[failureAttempts.length - 1].diagnostics = lastFailure.diagnostics;
      }
    }

    log.error(
      `All retries failed for automatic backup ${appname}. Status ${failureStatusPersisted ? 'set to failing' : 'update failed and remains protected by its dispatch lease'}.`,
      lastFailure?.reason,
    );
    await recordAutomaticRunActivity({
      automaticBackup,
      runStartedAt: automaticRunStartedAt,
      batchKey: automaticRunBatchKey,
      outcome: 'failed',
      stage: lastFailure?.stage || 'automatic_backup',
      reason: lastFailure?.reason || 'All retries exhausted',
    });
    await notifyAutomaticBackupFailureOnce(automaticBackup, {
      appname,
      stage: lastFailure?.stage || 'automatic_backup',
      reason: lastFailure?.reason || 'All retries exhausted',
      taskFailures: lastFailure?.taskFailures || [],
      failureAttempts,
      retryCount,
      maxRetries,
    });
    return false;
  } catch (error) {
    log.error('Error in processAutomaticBackup:', error.message);

    // Update status to failing if we have the backup record
    if (automaticBackup) {
      try {
        await dbCli.execute(
          `UPDATE automatic_backups SET status = ?, dispatch_token = NULL,
            dispatch_lease_until = 0 WHERE id = ? AND dispatch_token = ?`,
          ['failing', automaticBackup.id, automaticBackup.dispatch_token],
        );
      } catch (updateError) {
        log.error('Failed to update status to failing:', updateError.message);
      }

      await recordAutomaticRunActivity({
        automaticBackup,
        runStartedAt: automaticRunStartedAt || Date.now(),
        batchKey: automaticRunBatchKey,
        outcome: 'failed',
        stage: inferFailureStage(error),
        reason: getErrorMessage(error),
      });

      await notifyAutomaticBackupFailureOnce(automaticBackup, {
        appname: automaticBackup.appname,
        stage: inferFailureStage(error),
        reason: getErrorMessage(error),
        taskFailures: error.taskFailures || lastFailure?.taskFailures || [],
        failureAttempts: failureAttempts.length > 0 ? failureAttempts : [{
          attempt: retryCount || 1,
          stage: inferFailureStage(error),
          reason: getErrorMessage(error),
          diagnostics: error.diagnostics || [],
        }],
        retryCount,
        maxRetries,
      });
    }

    return false;
  }
}

async function runAutomaticBackupDispatcher(
  operation,
  maxConcurrent = config.automaticBackupSchedule.maxConcurrentAutomaticBackups,
) {
  const concurrencyLimit = Math.max(1, Number(maxConcurrent) || 1);
  if (activeAutomaticBackupDispatchers >= concurrencyLimit) {
    log.warn(`Skipping automatic backup dispatcher tick because all ${concurrencyLimit} slots are active`);
    return false;
  }
  activeAutomaticBackupDispatchers += 1;
  try {
    return await operation();
  } finally {
    activeAutomaticBackupDispatchers -= 1;
  }
}

async function processAutomaticBackup() {
  return runAutomaticBackupDispatcher(processAutomaticBackupInternal);
}

/**
 * Initializes the backup service and DB.
 *
 * @async
 */
async function init() {
  log.info('Initiating Database...');
  dbCli = await DBClient.createClient();
  await dbCli.checkSchema();
  await logFluxDriveStoredSize();
  setTimeout(async () => {
    await reconcileFluxDriveInventory();
  }, 30 * 1000);
  setInterval(async () => {
    await updateQueue();
  }, 20 * 1000);
  await dbCli.checkSchema();
  setInterval(async () => {
    await checkExpiredApps();
  }, 60 * 60 * 1000);
  // Sync Syncthing apps periodically
  setInterval(async () => {
    await syncSyncthingApps();
  }, 24 * 60 * 60 * 1000); // Run every 24 hours
  log.info('Syncthing app sync scheduled every 24 hours; startup sync skipped');

  setTimeout(async () => {
    const period = dailyBackupReport.getPreviousUtcPeriod();
    const sent = await sendDailyBackupReport(period);
    if (sent === false) {
      setTimeout(async () => {
        await sendDailyBackupReport(period);
      }, 60 * 60 * 1000);
    }
  }, config.dailyBackupReport.startupDelaySeconds * 1000);
  scheduleNextDailyBackupReport();
  log.info(`Daily Discord backup report scheduled for ${String(config.dailyBackupReport.hourUtc).padStart(2, '0')}:${String(config.dailyBackupReport.minuteUtc).padStart(2, '0')} UTC`);

  // Start the next due automatic backup at the configured dispatcher interval.
  setInterval(async () => {
    await processAutomaticBackup();
  }, config.automaticBackupSchedule.dispatcherIntervalMinutes * 60 * 1000);

  // Periodic cleanup of incomplete automatic-backup artifacts
  setInterval(async () => {
    await cleanupOldAutomaticBackups();
    await reconcileFluxDriveInventory();
  }, 24 * 60 * 60 * 1000); // Run every 24 hours
}

module.exports = {
  init,
  registerBackupTask,
  getBackupList,
  getTaskStatus,
  removeCheckpoint,
  syncSyncthingApps,
  processAutomaticBackup,
  waitForTasksToComplete,
  cleanupOldAutomaticBackups,
  reconcileFluxDriveInventory,
  sendDailyBackupReport,
  getDailyBackupReport,
  forceSendDailyBackupReport,
  testHooks: {
    claimNextAutomaticBackup,
    persistAutomaticBackupCompletion,
    runAutomaticBackupDispatcher,
    inferFailureStage,
    buildAutomaticFailureFingerprint,
    notifyAutomaticBackupFailureOnce,
    getTaskOutcome,
    buildTaskFailure,
  },
};
