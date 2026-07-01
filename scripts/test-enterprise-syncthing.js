#!/usr/bin/env node
/**
 * Test script: discover Syncthing apps from globalappsspecifications,
 * including enterprise apps that require decryption on an ArcaneOS node.
 *
 * Usage:
 *   node scripts/test-enterprise-syncthing.js
 *   TEST_ENTERPRISE_LIMIT=20 node scripts/test-enterprise-syncthing.js
 */

const axios = require('axios');
const https = require('https');
const Vault = require('../src/services/Vault');
const fluxOS = require('../src/services/fluxOsService');
const enterpriseCrypto = require('../src/services/enterpriseCrypto');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const ENTERPRISE_LIMIT = Number(process.env.TEST_ENTERPRISE_LIMIT || 10);

function log(message) {
  // eslint-disable-next-line no-console
  console.log(message);
}

async function fetchGlobalAppSpecs() {
  const response = await axios.get(
    `${enterpriseCrypto.FLUX_API}/apps/globalappsspecifications`,
    {
      httpsAgent,
      timeout: 120000,
      headers: { 'x-apicache-bypass': 'true' },
    },
  );

  if (response.data?.status !== 'success' || !Array.isArray(response.data.data)) {
    throw new Error('Failed to fetch globalappsspecifications');
  }

  return response.data.data;
}

async function inspectEnterpriseApps(enterpriseApps) {
  const teamFluxID = await Vault.getKey('teamFluxID');
  const teamPK = await Vault.getKey('teamPK');
  const arcaneSessions = await enterpriseCrypto.createArcaneNodeSessions(
    teamFluxID,
    teamPK,
    enterpriseCrypto.ARCANE_NODE_RETRY_COUNT,
  );

  log(`ArcaneOS nodes: ${arcaneSessions.map((session) => session.nodeBase).join(', ')}`);

  const results = [];
  const sample = enterpriseApps.slice(0, ENTERPRISE_LIMIT);

  for (let i = 0; i < sample.length; i += 1) {
    const app = sample[i];
    try {
      const decryptedFields = await enterpriseCrypto.decryptEnterpriseSpecWithRetry(
        app,
        arcaneSessions,
      );
      const mergedSpec = {
        ...app,
        compose: decryptedFields.compose || [],
        contacts: decryptedFields.contacts || [],
      };
      const syncthingInfo = enterpriseCrypto.getSyncthingAppInfo(mergedSpec);
      results.push({
        appName: app.name,
        decrypted: true,
        ...syncthingInfo,
      });
      log(`  [enterprise] ${app.name}: compose=${syncthingInfo.componentNames.length}, syncthing=${syncthingInfo.hasSyncthing ? syncthingInfo.syncthingComponents.join(', ') : 'none'}`);
    } catch (error) {
      results.push({
        appName: app.name,
        decrypted: false,
        error: error.message,
        hasSyncthing: false,
      });
      log(`  [enterprise] ${app.name}: DECRYPT FAILED - ${error.message}`);
    }
  }

  return results;
}

async function main() {
  log('Fetching global app specifications...');
  const allApps = await fetchGlobalAppSpecs();
  log(`Total apps: ${allApps.length}`);

  const plainApps = allApps.filter((app) => !enterpriseCrypto.isEnterpriseApp(app));
  const enterpriseApps = allApps.filter((app) => enterpriseCrypto.isEnterpriseApp(app));

  log(`Plain apps: ${plainApps.length}`);
  log(`Enterprise apps (version >= 8 with enterprise blob): ${enterpriseApps.length}`);

  const plainSyncthingApps = plainApps
    .map((app) => enterpriseCrypto.getSyncthingAppInfo(app))
    .filter((app) => app.hasSyncthing);

  log(`\nPlain apps with Syncthing (${plainSyncthingApps.length}):`);
  plainSyncthingApps.slice(0, 20).forEach((app) => {
    log(`  ${app.appName}: ${app.syncthingComponents.join(', ')}`);
  });
  if (plainSyncthingApps.length > 20) {
    log(`  ... and ${plainSyncthingApps.length - 20} more`);
  }

  log(`\nDecrypting up to ${ENTERPRISE_LIMIT} enterprise apps on ArcaneOS nodes...`);
  const enterpriseResults = await inspectEnterpriseApps(enterpriseApps);

  const enterpriseSyncthingApps = enterpriseResults.filter((result) => result.hasSyncthing);
  const enterpriseDecryptFailures = enterpriseResults.filter((result) => !result.decrypted);

  log('\nRunning getAppsWithSyncthing() integration check...');
  const integratedApps = await fluxOS.getAppsWithSyncthing();
  log(`getAppsWithSyncthing returned ${integratedApps?.length || 0} apps`);

  log('\n=== Summary ===');
  log(`Plain Syncthing apps: ${plainSyncthingApps.length}`);
  log(`Enterprise apps tested: ${enterpriseResults.length}`);
  log(`Enterprise decrypt failures: ${enterpriseDecryptFailures.length}`);
  log(`Enterprise Syncthing apps (from sample): ${enterpriseSyncthingApps.length}`);
  log(`Integrated Syncthing apps: ${integratedApps?.length || 0}`);

  if (enterpriseDecryptFailures.length > 0) {
    log('\nEnterprise decrypt failures:');
    enterpriseDecryptFailures.forEach((app) => {
      log(`  ${app.appName}: ${app.error}`);
    });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
