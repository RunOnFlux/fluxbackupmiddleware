const path = require('path');

require('dotenv').config();

module.exports = {
  serverPort: 80,
  dbUser: 'root',
  dbPort: 3306,
  dbhost: '127.0.0.1',
  dbConnectionLimit: 10,
  dbConnectTimeoutMs: 10000,
  dbQueryTimeoutMs: 15000,
  dbOperationTimeoutMs: 20000,
  dbSlowQueryMs: 2000,
  maxConcurrentTasks: 10,
  quotaPerUser: 50, // GB
  automaticBackupSchedule: {
    standardIntervalHours: 7 * 24,
    marketplaceIntervalHours: 24,
    dispatcherIntervalMinutes: 2,
    maxConcurrentAutomaticBackups: 4,
    dispatcherLeaseMinutes: 6 * 60,
    discordFailureCooldownMinutes: 60,
  },
  dailyBackupReport: {
    hourUtc: 0,
    minuteUtc: 5,
    startupDelaySeconds: 60,
  },
  marketplaceCatalog: {
    url: 'https://api.marketplace.runonflux.io/api/v1/marketplace/apps',
    cacheHours: 24,
  },
  // Keep transient backup files in a deterministic location regardless of the
  // process working directory used by PM2.
  storagePath: process.env.BACKUP_STORAGE_PATH || path.resolve(__dirname, '../tmp'),
  fluxDriveMaxFileSizeMb: 5120,
  storageMinimumFreeGb: 10,
  hostAPIPath: '/',
  fluxTeamZelId: '1hjy4bCYBJr4mny4zCE85J94RXa8W6q37',
  HCPEndpointURL: process.env.HCP_ENDPOINT_URL,
  HCPClientID: process.env.HCP_CLIENT_ID,
  HCPClientSecret: process.env.HCP_CLIENT_SECRET,
  HCPOrgID: process.env.HCP_ORG_ID,
  HCPProjectID: process.env.HCP_PROJECT_ID,
  HCPAppID: process.env.HCP_APP_ID,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
  ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL || 'https://jetpack2_38080.app.runonflux.io/ipfs',
  version: '1.0.0',
};
