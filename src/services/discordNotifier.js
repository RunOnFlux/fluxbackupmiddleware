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

function formatTaskFailures(taskFailures) {
  if (!taskFailures || taskFailures.length === 0) {
    return null;
  }

  return taskFailures
    .map((failure) => {
      const taskLabel = failure.taskId ? `Task ${failure.taskId}` : 'Task n/a';
      const failCount = failure.fails ? ` [${failure.fails} fails]` : '';
      return `- ${taskLabel} (${failure.component}): ${failure.message}${failCount}`;
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
 * @param {number} [params.retryCount]
 * @param {number} [params.maxRetries]
 * @returns {Promise<boolean>}
 */
async function notifyAutomaticBackupFailure({
  appname,
  stage,
  reason,
  taskFailures = [],
  retryCount,
  maxRetries,
}) {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) {
    log.warn('Discord webhook URL not configured; skipping automatic backup failure notification');
    return false;
  }

  const lines = [
    '**Automatic backup failed**',
    `**App:** ${appname}`,
    `**Stage:** ${stage}`,
    `**Reason:** ${reason}`,
  ];

  if (typeof retryCount === 'number' && typeof maxRetries === 'number') {
    lines.push(`**Retries:** ${retryCount}/${maxRetries}`);
  }

  const taskFailureLines = formatTaskFailures(taskFailures);
  if (taskFailureLines) {
    lines.push('**Task failures:**');
    lines.push(taskFailureLines);
  }

  try {
    await axios.post(webhookUrl, { content: truncate(lines.join('\n')) }, { timeout: 10000 });
    log.info(`Discord notification sent for automatic backup failure (${appname})`);
    return true;
  } catch (error) {
    log.error('Failed to send Discord notification:', error);
    return false;
  }
}

module.exports = {
  notifyAutomaticBackupFailure,
};
