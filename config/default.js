require('dotenv').config();

module.exports = {
  serverPort: 80,
  dbUser: 'root',
  dbPort: 3306,
  dbhost: '127.0.0.1',
  maxConcurrentTasks: 10,
  quotaPerUser: 10, // GB
  maxFilesPerApp: 12,
  storagePath: './tmp/',
  hostAPIPath: '/',
  fluxTeamZelId: '1hjy4bCYBJr4mny4zCE85J94RXa8W6q37',
  HCPEndpointURL: process.env.HCP_ENDPOINT_URL,
  HCPClientID: process.env.HCP_CLIENT_ID,
  HCPClientSecret: process.env.HCP_CLIENT_SECRET,
  HCPOrgID: process.env.HCP_ORG_ID,
  HCPProjectID: process.env.HCP_PROJECT_ID,
  HCPAppID: process.env.HCP_APP_ID,
  version: '1.0.0',
};
