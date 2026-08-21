const axios = require('axios');
const config = require('../../config/default');
const Vault = require('./Vault');
const log = require('../lib/log');

const DISCORD_CONTENT_LIMIT = 2000;

async function getWebhookUrl() {
  const fromVault = await Vault.getKey('discordWebhookUrl');
  if (fromVault) return fromVault;
  return config.discordWebhookUrl || null;
}

function truncate(content, max = DISCORD_CONTENT_LIMIT) {
  if (content.length <= max) return content;
  return `${content.slice(0, max - 3)}...`;
}

async function sendDiscordContent(content, description) {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) {
    log.warn(`Discord webhook URL not configured; skipping ${description}`);
    return false;
  }
  try {
    await axios.post(webhookUrl, { content: truncate(content) }, { timeout: 10000 });
    log.info(`Discord ${description} sent`);
    return true;
  } catch (error) {
    log.error(`Failed to send Discord ${description}:`, error);
    return false;
  }
}

function sanitizeDiagnosticText(value, max = 300) {
  if (value === null || typeof value === 'undefined') return '';
  const sanitized = String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/(zelidauth|loginPhrase|signature)=([^&\s]+)/gi, '$1=[redacted]');
  return truncate(sanitized, max);
}

function formatDiagnostic(diagnostic) {
  const fields = [
    `**${sanitizeDiagnosticText(diagnostic.check || 'Check', 80)}**`,
    diagnostic.outcome ? sanitizeDiagnosticText(diagnostic.outcome, 20) : null,
    diagnostic.node ? `node=${sanitizeDiagnosticText(diagnostic.node, 80)}` : null,
    diagnostic.httpStatus ? `HTTP=${diagnostic.httpStatus}` : null,
    diagnostic.errorCode ? `code=${sanitizeDiagnosticText(diagnostic.errorCode, 40)}` : null,
    diagnostic.detail ? sanitizeDiagnosticText(diagnostic.detail, 180) : null,
    diagnostic.endpoint ? `<${sanitizeDiagnosticText(diagnostic.endpoint, 240)}>` : null,
  ].filter(Boolean);
  return `- ${fields.join(' | ')}`;
}

function summarizeAttempt(attempt) {
  const diagnostics = attempt.diagnostics || [];
  const decisiveCheck = [...diagnostics].reverse().find((item) => item.outcome === 'failed')
    || diagnostics[diagnostics.length - 1];
  if (decisiveCheck) {
    return [
      sanitizeDiagnosticText(attempt.stage || 'automatic_backup', 40),
      sanitizeDiagnosticText(decisiveCheck.check || attempt.reason, 80),
      decisiveCheck.node ? `node=${sanitizeDiagnosticText(decisiveCheck.node, 80)}` : null,
      decisiveCheck.httpStatus ? `HTTP=${decisiveCheck.httpStatus}` : null,
      decisiveCheck.errorCode ? `code=${sanitizeDiagnosticText(decisiveCheck.errorCode, 40)}` : null,
      sanitizeDiagnosticText(decisiveCheck.detail || attempt.reason, 160),
    ].filter(Boolean).join(' | ');
  }
  return `${sanitizeDiagnosticText(attempt.stage || 'automatic_backup', 40)} | ${sanitizeDiagnosticText(attempt.reason, 220)}`;
}

function formatFailureAttempts(failureAttempts) {
  if (!failureAttempts || failureAttempts.length === 0) return null;

  const grouped = new Map();
  failureAttempts.forEach((attempt) => {
    const summary = summarizeAttempt(attempt);
    const attempts = grouped.get(summary) || [];
    attempts.push(attempt.attempt);
    grouped.set(summary, attempts);
  });

  const lines = [];
  grouped.forEach((attempts, summary) => {
    lines.push(`- Attempt${attempts.length > 1 ? 's' : ''} ${attempts.join(', ')}: ${summary}`);
  });

  const finalAttempt = failureAttempts[failureAttempts.length - 1];
  if (finalAttempt.diagnostics?.length > 0) {
    const selectionChecks = new Set([
      'FDM HAProxy statistics',
      'FDM appips',
      'Flux location API',
    ]);
    const relevantDiagnostics = finalAttempt.diagnostics.filter((diagnostic) => (
      diagnostic.outcome === 'failed' || selectionChecks.has(diagnostic.check)
    ));
    const displayedDiagnostics = relevantDiagnostics.slice(-8);
    lines.push('**Final attempt checks:**');
    if (displayedDiagnostics.length < relevantDiagnostics.length) {
      lines.push(`- ${relevantDiagnostics.length - displayedDiagnostics.length} earlier checks omitted`);
    }
    displayedDiagnostics.forEach((diagnostic) => {
      lines.push(formatDiagnostic(diagnostic));
    });
  }
  return lines.join('\n');
}

function formatTaskFailures(taskFailures) {
  if (!taskFailures || taskFailures.length === 0) {
    return null;
  }

  return taskFailures
    .map((failure) => {
      const component = failure.component || 'unknown';
      const failCount = failure.fails ? ` (${failure.fails} attempts)` : '';
      const node = failure.node ? ` | node=${sanitizeDiagnosticText(failure.node, 100)}` : '';
      const endpoint = failure.endpoint
        ? ` | endpoint=<${sanitizeDiagnosticText(failure.endpoint, 220)}>` : '';
      const httpStatus = failure.httpStatus ? ` | HTTP=${failure.httpStatus}` : '';
      const errorCode = failure.errorCode
        ? ` | code=${sanitizeDiagnosticText(failure.errorCode, 40)}` : '';
      if (failure.taskId) {
        return `- **${component}** — task #${failure.taskId}${failCount}${node}${httpStatus}${errorCode}${endpoint}: ${sanitizeDiagnosticText(failure.message, 260)}`;
      }
      return `- **${component}**${node}${httpStatus}${errorCode}${endpoint}: ${sanitizeDiagnosticText(failure.message, 260)}`;
    })
    .join('\n');
}

/**
 * Sends a Discord webhook notification when an automatic backup fails.
 *
 * @async
 * @param {Object} params
 * @param {string} params.appname
 * @param {string} params.stage
 * @param {string} params.reason
 * @param {Array<Object>} [params.taskFailures]
 * @param {Array<Object>} [params.failureAttempts]
 * @param {number} [params.retryCount]
 * @param {number} [params.maxRetries]
 * @returns {Promise<boolean>}
 */
async function notifyAutomaticBackupFailure({
  appname,
  stage,
  reason,
  taskFailures = [],
  failureAttempts = [],
  retryCount,
  maxRetries,
}) {
  const lines = [
    '**Automatic backup failed**',
    `**App:** ${sanitizeDiagnosticText(appname, 128)}`,
    `**Stage:** ${sanitizeDiagnosticText(stage, 64)}`,
    `**Reason:** ${sanitizeDiagnosticText(reason, 400)}`,
  ];

  if (typeof retryCount === 'number' && typeof maxRetries === 'number') {
    lines.push(`**Retries:** ${retryCount}/${maxRetries}`);
  }

  const attemptLines = formatFailureAttempts(failureAttempts);
  if (attemptLines) {
    lines.push('**Attempt diagnostics:**');
    lines.push(attemptLines);
  }

  const taskFailureLines = formatTaskFailures(taskFailures);
  if (taskFailureLines) {
    lines.push('**Component details:**');
    lines.push(taskFailureLines);
  }

  return sendDiscordContent(
    lines.join('\n'),
    `automatic backup failure notification (${appname})`,
  );
}

async function sendDailyBackupReport(content, reportDate) {
  return sendDiscordContent(content, `daily backup report (${reportDate})`);
}

module.exports = {
  formatDiagnostic,
  formatFailureAttempts,
  notifyAutomaticBackupFailure,
  sendDailyBackupReport,
};
