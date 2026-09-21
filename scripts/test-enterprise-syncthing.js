#!/usr/bin/env node
/* eslint-disable no-await-in-loop */
/**
 * Test script: discover Syncthing apps from globalappsspecifications,
 * including enterprise apps that require SAS-assisted local decryption.
 *
 * Usage:
 *   node scripts/test-enterprise-syncthing.js
 *   TEST_ENTERPRISE_LIMIT=20 node scripts/test-enterprise-syncthing.js
 *   TEST_ENTERPRISE_APP=valheim123 node scripts/test-enterprise-syncthing.js
 */

const axios = require('axios');
const https = require('https');
const fluxOS = require('../src/services/fluxOsService');
const enterpriseCrypto = require('../src/services/enterpriseCrypto');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const ENTERPRISE_LIMIT = Number(process.env.TEST_ENTERPRISE_LIMIT || 10);
const ENTERPRISE_APP = process.env.TEST_ENTERPRISE_APP;
const RUN_FULL_DISCOVERY = process.env.TEST_ENTERPRISE_FULL_DISCOVERY === 'true';

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
  await enterpriseCrypto.assertSasConfigured();
  log('SAS mTLS configuration loaded successfully');

  const results = [];
  const sample = enterpriseApps.slice(0, ENTERPRISE_LIMIT);

  for (let i = 0; i < sample.length; i += 1) {
    const app = sample[i];
    try {
      const decryptedFields = await enterpriseCrypto.decryptEnterpriseSpecWithSas(app);
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
  const enterpriseAppsToTest = ENTERPRISE_APP
    ? enterpriseApps.filter((app) => app.name === ENTERPRISE_APP)
    : enterpriseApps;

  if (ENTERPRISE_APP && enterpriseAppsToTest.length === 0) {
    throw new Error(`Enterprise app ${ENTERPRISE_APP} was not found in global specifications`);
  }

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

  log(`\nDecrypting up to ${ENTERPRISE_LIMIT} enterprise apps through SAS...`);
  const enterpriseResults = await inspectEnterpriseApps(enterpriseAppsToTest);

  const enterpriseSyncthingApps = enterpriseResults.filter((result) => result.hasSyncthing);
  const enterpriseDecryptFailures = enterpriseResults.filter((result) => !result.decrypted);

  let integratedApps = null;
  if (RUN_FULL_DISCOVERY) {
    log('\nRunning getAppsWithSyncthing() full integration check...');
    integratedApps = await fluxOS.getAppsWithSyncthing();
    log(`getAppsWithSyncthing returned ${integratedApps?.length || 0} apps`);
  }

  log('\n=== Summary ===');
  log(`Plain Syncthing apps: ${plainSyncthingApps.length}`);
  log(`Enterprise apps tested: ${enterpriseResults.length}`);
  log(`Enterprise decrypt failures: ${enterpriseDecryptFailures.length}`);
  log(`Enterprise Syncthing apps (from sample): ${enterpriseSyncthingApps.length}`);
  if (RUN_FULL_DISCOVERY) {
    log(`Integrated Syncthing apps: ${integratedApps?.length || 0}`);
  }

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
