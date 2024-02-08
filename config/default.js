require('dotenv').config();

const { HCP_ENDPOINT_URL } = process.env;
const { HCP_CLIENT_ID } = process.env;
const { HCP_CLIENT_SECRET } = process.env;
const { HCP_ORG_ID } = process.env;
const { HCP_PROJECT_ID } = process.env;
const { HCP_APP_ID } = process.env;
module.exports = {
  serverPort: 7071,
  dbUser: 'root',
  dbPort: 3306,
  dbhost: 'localhost',
  maxConcurrentTasks: 10,
  quotaPerUser: 10, // GB
  storagePath: './tmp/',
  hostAPIPath: '/',
  fluxTeamZelId: '1hjy4bCYBJr4mny4zCE85J94RXa8W6q37',
  HCPEndpointURL: HCP_ENDPOINT_URL,
  HCPClientID: HCP_CLIENT_ID,
  HCPClientSecret: HCP_CLIENT_SECRET,
  HCPOrgID: HCP_ORG_ID,
  HCPProjectID: HCP_PROJECT_ID,
  HCPAppID: HCP_APP_ID,
  version: '1.0.0',
};
