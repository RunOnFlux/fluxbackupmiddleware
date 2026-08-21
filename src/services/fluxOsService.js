/* eslint-disable no-param-reassign */
/* eslint-disable no-await-in-loop */
const axios = require('axios');
const https = require('https');
const appOwners = require('memory-cache');
const qs = require('qs');
const zeltrezjs = require('zeltrezjs');
const bitcoinMessage = require('bitcoinjs-message');
const log = require('../lib/log');
const Vault = require('./Vault');
const enterpriseCrypto = require('./enterpriseCrypto');
const enterpriseDiscoveryCache = require('./utils/enterpriseDiscoveryCache');

// Create HTTPS agent that accepts insecure connections
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const sessionExpireTime = 1 * 60 * 60 * 1000;

function getSafeApiMessage(data) {
  const message = data?.data?.message || data?.message
    || (typeof data?.data === 'string' ? data.data : null);
  return message ? String(message).slice(0, 240) : null;
}

function getRequestFailure(error) {
  return {
    errorCode: error.code || null,
    httpStatus: error.response?.status || null,
    detail: getSafeApiMessage(error.response?.data) || error.message,
  };
}

/**
 * Retrieves FluxOS app specifications for given appname.
 *
 * @async
 * @returns {Promise<Object|null>} - A promise that resolves to the status data if the request is successful, or null if the request fails.
 */
async function getAppSpecs(appname, retuenApiErrors = false) {
  if (!appname) return false;
  try {
    const result = await axios({
      method: 'get',
      url: `https://api.runonflux.io/apps/appspecifications/${appname}`,
      httpsAgent,
    });
    if (result.data && result.data.status && result.data.status === 'success') {
      return result.data.data;
    }
    if (retuenApiErrors && result.data && result.data.status && result.data.status === 'error') {
      return result.data.data.message;
    }
    return false;
  } catch (e) {
    log.error(e);
    return false;
  }
}

/**
 * Retrieves FluxOS daemon block height.
 *
 * @async
 * @returns {Promise<Object|null>} - A promise that resolves to the status data if the request is successful, or null if the request fails.
 */
async function getBlockHeight() {
  try {
    const result = await axios({
      method: 'get',
      url: 'https://api.runonflux.io/daemon/getblockcount',
      httpsAgent,
    });
    if (result.data && result.data.status && result.data.status === 'success') {
      return result.data.data;
    }
    return false;
  } catch (e) {
    log.error(e);
    return false;
  }
}

/**
* [verifyAppOwner]
*/
async function verifyAppOwner(owner, appname) {
  // eslint-disable-next-line no-param-reassign
  let value = appOwners.get(appname);
  if (!value) {
    const appSpecs = await getAppSpecs(appname);
    if (appSpecs) {
      value = { owner: appSpecs.owner, expireHeight: appSpecs.expire + appSpecs.height };
      appOwners.put(appname, value, sessionExpireTime);
    }
  }

  // Check if owner matches
  if (value && value.owner === owner) {
    return true;
  }

  const teamFluxID = await Vault.getKey('teamFluxID');
  if (owner === teamFluxID) {
    log.info(`App ${appname} verified as owned by teamFluxID`);
    return true;
  }
  return false;
}
/**
* [getAppExpireHeight]
*/
async function getAppExpireHeight(appname) {
  // eslint-disable-next-line no-param-reassign
  let value = appOwners.get(appname);
  if (!value) {
    const appSpecs = await getAppSpecs(appname);
    if (appSpecs) {
      value = { owner: appSpecs.owner, expireHeight: appSpecs.expire + appSpecs.height };
      appOwners.put(appname, value, sessionExpireTime);
    }
  }
  if (value) return value.expireHeight;
  return false;
}

/**
* [getAppOwner]
*/
async function getAppOwnerDetailed(appname) {
  let value = appOwners.get(appname);
  if (value) {
    return {
      owner: value.owner,
      diagnostics: [{
        check: 'Flux app owner',
        outcome: 'success',
        detail: 'App owner loaded from middleware cache',
      }],
    };
  }

  const endpoint = `https://api.runonflux.io/apps/appspecifications/${appname}`;
  try {
    const response = await axios.get(endpoint, { httpsAgent, timeout: 30000 });
    if (response.data?.status === 'success' && response.data.data?.owner) {
      const appSpecs = response.data.data;
      value = { owner: appSpecs.owner, expireHeight: appSpecs.expire + appSpecs.height };
      appOwners.put(appname, value, sessionExpireTime);
      return {
        owner: value.owner,
        diagnostics: [{
          check: 'Flux app owner',
          outcome: 'success',
          endpoint,
          httpStatus: response.status,
          detail: 'App owner returned by specifications API',
        }],
      };
    }
    return {
      owner: null,
      diagnostics: [{
        check: 'Flux app owner',
        outcome: 'failed',
        endpoint,
        httpStatus: response.status,
        detail: getSafeApiMessage(response.data) || 'Specifications API returned no app owner',
      }],
    };
  } catch (error) {
    log.error(`Failed to get app owner for ${appname}:`, error.message);
    return {
      owner: null,
      diagnostics: [{
        check: 'Flux app owner',
        outcome: 'failed',
        endpoint,
        ...getRequestFailure(error),
      }],
    };
  }
}

async function getAppOwner(appname) {
  const result = await getAppOwnerDetailed(appname);
  return result.owner || false;
}

const DEFAULT_FLUX_API_PORT = 16127;

function getFdmIndex(appName) {
  const firstLetter = appName.substring(0, 1).toLowerCase();
  if (firstLetter.match(/[h-n]/)) {
    return 2;
  }
  if (firstLetter.match(/[o-u]/)) {
    return 3;
  }
  if (firstLetter.match(/[v-z]/)) {
    return 4;
  }
  return 1;
}

function getFdmBaseUrl(appName) {
  return `https://fdm-fn-1-${getFdmIndex(appName)}.runonflux.io`;
}

function extractNodeIp(ipOrHostPort) {
  return ipOrHostPort.includes(':') ? ipOrHostPort.split(':')[0] : ipOrHostPort;
}

function formatLocationNode(ipOrHostPort) {
  if (ipOrHostPort.includes(':')) {
    return ipOrHostPort;
  }
  return `${ipOrHostPort}:${DEFAULT_FLUX_API_PORT}`;
}

function parseSecondaryNodeFromHAProxyStats(htmlContent, appname) {
  const serverRowRegex = /<tr class="(?:active_up|backup_up|active_down|backup_down)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;

  let secondaryNode = null;
  const activeNodes = [];
  let match = serverRowRegex.exec(htmlContent);

  while (match !== null) {
    const rowContent = match[1];
    const ipMatch = rowContent.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+)/);

    if (ipMatch) {
      if (match[0].includes('backup_up')) {
        [secondaryNode] = ipMatch;
        break;
      }
      if (match[0].includes('active_up')) {
        activeNodes.push(ipMatch[0]);
      }
    }
    match = serverRowRegex.exec(htmlContent);
  }

  if (!secondaryNode) {
    const tableRegex = /<table[^>]*>[\s\S]*?<\/table>/gi;
    const tables = htmlContent.match(tableRegex);

    if (tables) {
      tables.forEach((table) => {
        if (!secondaryNode && table.includes(appname) && table.includes('Backend')) {
          const backupServerRegex = /<tr[^>]*class="[^"]*backup[^"]*"[^>]*>[\s\S]*?<td[^>]*>(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+)[^<]*<\/td>[\s\S]*?<td[^>]*>UP<\/td>/gi;
          const backupMatch = backupServerRegex.exec(table);
          if (backupMatch) {
            [, secondaryNode] = backupMatch;
          }
        }
      });
    }
  }

  if (!secondaryNode && activeNodes.length > 1) {
    [, secondaryNode] = activeNodes;
    log.info(`No backup nodes found for ${appname}, using second active node: ${secondaryNode}`);
  }

  return secondaryNode;
}

async function getPrimaryNodeIp(appname, diagnostics) {
  const appIpsUrl = `${getFdmBaseUrl(appname)}/api/appips/${appname}`;
  try {
    const response = await axios.get(appIpsUrl, { httpsAgent, timeout: 30000 });

    if (response.data?.status === 'success' && response.data?.data?.ips?.length > 0) {
      const [primaryIp] = response.data.data.ips;
      diagnostics.push({
        check: 'FDM appips',
        outcome: 'success',
        endpoint: appIpsUrl,
        node: primaryIp,
        detail: `Primary IP found; FDM returned ${response.data.data.ips.length} IP(s)`,
      });
      log.info(`Primary node IP for ${appname} from appips: ${primaryIp}`);
      return primaryIp;
    }

    diagnostics.push({
      check: 'FDM appips',
      outcome: 'failed',
      endpoint: appIpsUrl,
      httpStatus: response.status,
      detail: getSafeApiMessage(response.data) || 'FDM response contained no primary IP',
    });
    log.error(`No primary IP found in appips response for ${appname}`);
    return null;
  } catch (error) {
    diagnostics.push({
      check: 'FDM appips',
      outcome: 'failed',
      endpoint: appIpsUrl,
      ...getRequestFailure(error),
    });
    log.error(`Failed to get primary node IP for ${appname}:`, error.message);
    return null;
  }
}

async function getSecondaryNodeFromLocationApi(appname, primaryIp, diagnostics) {
  const locationUrl = `https://api.runonflux.io/apps/location/${appname}`;
  try {
    const locationResponse = await axios.get(locationUrl, { httpsAgent, timeout: 30000 });

    if (!locationResponse.data || locationResponse.data.status !== 'success' || !locationResponse.data.data) {
      diagnostics.push({
        check: 'Flux location API',
        outcome: 'failed',
        endpoint: locationUrl,
        httpStatus: locationResponse.status,
        detail: getSafeApiMessage(locationResponse.data) || 'Invalid location API response',
      });
      log.error(`Invalid response from location API for ${appname}`);
      return null;
    }

    const locations = locationResponse.data.data;
    if (locations.length === 0) {
      diagnostics.push({
        check: 'Flux location API',
        outcome: 'failed',
        endpoint: locationUrl,
        httpStatus: locationResponse.status,
        detail: 'No running app locations were returned',
      });
      log.error(`No locations found for ${appname} in location API`);
      return null;
    }

    if (primaryIp) {
      const alternativeLocation = locations.find(
        (location) => extractNodeIp(location.ip) !== primaryIp,
      );

      if (alternativeLocation) {
        const secondaryNode = formatLocationNode(alternativeLocation.ip);
        diagnostics.push({
          check: 'Flux location API',
          outcome: 'success',
          endpoint: locationUrl,
          node: secondaryNode,
          detail: `Selected a location different from primary ${primaryIp}`,
        });
        log.info(`Found secondary node from location API (primary ${primaryIp}): ${secondaryNode}`);
        return secondaryNode;
      }

      diagnostics.push({
        check: 'Flux location API',
        outcome: 'failed',
        endpoint: locationUrl,
        httpStatus: locationResponse.status,
        node: primaryIp,
        detail: `Only the primary IP was available (${locations.length} location record(s))`,
      });
      log.warn(`All location nodes match primary IP ${primaryIp} for ${appname}`);
      return null;
    }

    diagnostics.push({
      check: 'Flux location API',
      outcome: 'failed',
      endpoint: locationUrl,
      detail: 'Primary IP was unavailable, so a safe secondary could not be identified',
    });
    log.error(`Cannot select secondary node for ${appname}: primary IP is required`);
    return null;
  } catch (error) {
    diagnostics.push({
      check: 'Flux location API',
      outcome: 'failed',
      endpoint: locationUrl,
      ...getRequestFailure(error),
    });
    log.error(`Failed to get location data for ${appname}:`, error.message);
    return null;
  }
}

/**
 * Gets the first secondary/backup node IP:port for a given app.
 * Uses FDM HAProxy statistics first, then falls back to FDM appips + location API.
 *
 * @async
 * @param {string} appname - The name of the application
 * @returns {Promise<Object>} Selected node and the diagnostic trail used to select it.
 */
async function getSecondaryNodeSelection(appname) {
  const diagnostics = [];
  const statsUrl = `${getFdmBaseUrl(appname)}/fluxstatistics?scope=${appname}_`;
  try {
    const response = await axios.get(statsUrl, { httpsAgent, timeout: 30000 });

    if (!response.data) {
      diagnostics.push({
        check: 'FDM HAProxy statistics',
        outcome: 'failed',
        endpoint: statsUrl,
        httpStatus: response.status,
        detail: 'FDM returned an empty statistics response',
      });
      log.error(`No data received from HAProxy statistics for ${appname}`);
    } else {
      const secondaryNode = parseSecondaryNodeFromHAProxyStats(response.data, appname);
      if (secondaryNode) {
        diagnostics.push({
          check: 'FDM HAProxy statistics',
          outcome: 'success',
          endpoint: statsUrl,
          node: secondaryNode,
          detail: 'Selected an UP backup node or second UP active node',
        });
        log.info(`Secondary/backup node for ${appname}: ${secondaryNode}`);
        return {
          node: secondaryNode,
          primaryIp: null,
          reason: null,
          diagnostics,
        };
      }

      diagnostics.push({
        check: 'FDM HAProxy statistics',
        outcome: 'failed',
        endpoint: statsUrl,
        httpStatus: response.status,
        detail: 'No UP backup node or second UP active node was present',
      });
      log.info(`HAProxy statistics for ${appname} did not yield a secondary node`);
    }
  } catch (error) {
    diagnostics.push({
      check: 'FDM HAProxy statistics',
      outcome: 'failed',
      endpoint: statsUrl,
      ...getRequestFailure(error),
    });
    log.error(`Failed to get HAProxy statistics for ${appname}`, { error: error.message });
  }

  log.info(`Using appips/location fallback for secondary node selection (${appname})`);
  const primaryIp = await getPrimaryNodeIp(appname, diagnostics);
  if (!primaryIp) {
    log.error(
      `Failed to select secondary node for ${appname}: appips did not return a primary IP; location API fallback requires primary node identification`,
    );
    return {
      node: null,
      primaryIp: null,
      reason: 'FDM appips did not return a primary IP',
      diagnostics,
    };
  }
  const secondaryNode = await getSecondaryNodeFromLocationApi(
    appname,
    primaryIp,
    diagnostics,
  );
  return {
    node: secondaryNode,
    primaryIp,
    reason: secondaryNode ? null : diagnostics[diagnostics.length - 1]?.detail,
    diagnostics,
  };
}

async function getSecondaryNodeFromHAProxy(appname) {
  const selection = await getSecondaryNodeSelection(appname);
  return selection.node;
}

async function getLoginPhraseDetailed(node) {
  const endpoint = `${node}/id/loginphrase`;
  try {
    const response = await axios.get(endpoint, { httpsAgent, timeout: 30000 });
    if (response.data.status === 'error') {
      const detail = getSafeApiMessage(response.data) || 'Node rejected login phrase request';
      log.error(`Failed to get login phrase from Flux API: ${detail}`);
      return {
        phrase: null,
        diagnostic: {
          check: 'Flux node login phrase',
          outcome: 'failed',
          endpoint,
          node,
          httpStatus: response.status,
          detail,
        },
      };
    }
    if (!response.data.data) {
      return {
        phrase: null,
        diagnostic: {
          check: 'Flux node login phrase',
          outcome: 'failed',
          endpoint,
          node,
          httpStatus: response.status,
          detail: 'Node returned no login phrase',
        },
      };
    }
    return {
      phrase: response.data.data,
      diagnostic: {
        check: 'Flux node login phrase',
        outcome: 'success',
        endpoint,
        node,
        httpStatus: response.status,
        detail: 'Login phrase received',
      },
    };
  } catch (error) {
    log.error(`Failed to get login phrase from Flux API: ${error.message}`, { stack: error.stack });
    return {
      phrase: null,
      diagnostic: {
        check: 'Flux node login phrase',
        outcome: 'failed',
        endpoint,
        node,
        ...getRequestFailure(error),
      },
    };
  }
}

function signMessage(message, pk, strMessageMagic) {
  try {
    let privKey = pk;
    if (privKey.length !== 64) {
      privKey = zeltrezjs.address.WIFToPrivKey(privKey);
    }
    const privateKey = Buffer.from(privKey, 'hex');

    // Use bitcoinMessage.sign instead of zeltrezjs.message.sign
    const signature = bitcoinMessage.sign(message, privateKey, true, strMessageMagic);
    // bitcoinMessage.sign returns a Buffer, convert to base64 string
    return signature.toString('base64');
  } catch (e) {
    log.error(`Error signing message: ${e.message}`, { stack: e.stack });
    throw e;
  }
}

async function verifyLoginDetailed(zelid, privateKeySign, node) {
  const diagnostics = [];
  const verifyEndpoint = `${node}/id/verifylogin`;
  try {
    const loginPhraseResult = await getLoginPhraseDetailed(node);
    diagnostics.push(loginPhraseResult.diagnostic);
    if (!loginPhraseResult.phrase) {
      log.error('Failed to get login phrase');
      return {
        zelidAuth: null,
        reason: loginPhraseResult.diagnostic.detail,
        diagnostics,
      };
    }

    let signature;
    try {
      signature = signMessage(loginPhraseResult.phrase, privateKeySign);
    } catch (error) {
      diagnostics.push({
        check: 'Middleware login signing',
        outcome: 'failed',
        node,
        detail: error.message,
      });
      return { zelidAuth: null, reason: error.message, diagnostics };
    }
    const loginInfo = {
      zelid,
      signature,
      loginPhrase: loginPhraseResult.phrase,
    };

    const response = await axios.post(
      verifyEndpoint,
      qs.stringify(loginInfo),
      { httpsAgent, timeout: 30000 },
    );

    if (response.data.status === 'success') {
      const zelidAuth = qs.stringify(loginInfo);
      diagnostics.push({
        check: 'Flux node login verification',
        outcome: 'success',
        endpoint: verifyEndpoint,
        node,
        httpStatus: response.status,
        detail: 'Authentication successful',
      });
      log.info('Authentication successful');
      return { zelidAuth, reason: null, diagnostics };
    }

    const detail = getSafeApiMessage(response.data) || 'Node rejected login verification';
    diagnostics.push({
      check: 'Flux node login verification',
      outcome: 'failed',
      endpoint: verifyEndpoint,
      node,
      httpStatus: response.status,
      detail,
    });
    log.warn(`Login verification failed: ${detail}`);
    return { zelidAuth: null, reason: detail, diagnostics };
  } catch (error) {
    diagnostics.push({
      check: 'Flux node login verification',
      outcome: 'failed',
      endpoint: verifyEndpoint,
      node,
      ...getRequestFailure(error),
    });
    log.error(`Error in verifyLogin: ${error.message}`, { stack: error.stack });
    return { zelidAuth: null, reason: error.message, diagnostics };
  }
}

async function verifyLogin(zelid, privateKeySign, node) {
  const result = await verifyLoginDetailed(zelid, privateKeySign, node);
  return result.zelidAuth || false;
}

/**
 * Checks whether an app is expired via global app specifications.
 * Expired apps return success with an empty data array.
 *
 * @async
 * @param {string} appname
 * @returns {Promise<boolean|null>} - true if expired, false if active, null if check failed
 */
async function isAppExpiredInGlobalSpecs(appname) {
  try {
    const result = await axios({
      method: 'get',
      url: `https://api.runonflux.io/apps/globalappsspecifications?appname=${encodeURIComponent(appname)}`,
      httpsAgent,
    });

    if (result.data?.status === 'success' && Array.isArray(result.data.data)) {
      return result.data.data.length === 0;
    }

    log.warn(`Unexpected globalappsspecifications response for ${appname}`);
    return null;
  } catch (error) {
    log.error(`Failed to check global app specifications for ${appname}:`, error.message);
    return null;
  }
}

/**
 * Retrieves all global app specifications and filters for apps with Syncthing components.
 * Plain apps are checked directly. Enterprise apps (encrypted compose) are decrypted
 * on ArcaneOS nodes before checking containerData prefixes s:, r:, or g:.
 *
 * @async
 * @returns {Promise<Object|false>} Discovery results and cache changes, or false on fetch failure.
 */
async function discoverAppsWithSyncthing(
  cacheByName = new Map(),
  knownAppsByName = new Map(),
) {
  try {
    const result = await axios({
      method: 'get',
      url: `${enterpriseCrypto.FLUX_API}/apps/globalappsspecifications`,
      httpsAgent,
      timeout: 120000,
      headers: { 'x-apicache-bypass': 'true' },
    });

    if (!result.data || result.data.status !== 'success' || !Array.isArray(result.data.data)) {
      return false;
    }

    const allApps = result.data.data;
    const appsWithSyncthing = [];
    const cacheUpdates = [];
    const unresolvedEnterpriseAppNames = new Set();

    const plainApps = allApps.filter((app) => !enterpriseCrypto.isEnterpriseApp(app));
    const enterpriseApps = allApps.filter((app) => enterpriseCrypto.isEnterpriseApp(app));
    const currentEnterpriseAppNames = enterpriseApps.map((app) => app.name);
    const enterpriseAppsToDecrypt = [];
    let cacheHits = 0;
    let bootstrapHits = 0;
    let decryptFailures = 0;

    plainApps.forEach((app) => {
      const entry = enterpriseCrypto.buildSyncthingAppEntry(app);
      if (entry) {
        appsWithSyncthing.push(entry);
      }
    });

    enterpriseApps.forEach((app) => {
      const reusable = enterpriseDiscoveryCache.getReusableDiscovery(
        app,
        cacheByName,
        knownAppsByName,
      );
      if (!reusable) {
        enterpriseAppsToDecrypt.push(app);
        return;
      }
      if (reusable.source === 'cache') cacheHits += 1;
      if (reusable.source === 'bootstrap') bootstrapHits += 1;
      if (reusable.entry) appsWithSyncthing.push(reusable.entry);
      if (reusable.cacheUpdate) cacheUpdates.push(reusable.cacheUpdate);
    });

    if (enterpriseAppsToDecrypt.length > 0) {
      const teamFluxID = await Vault.getKey('teamFluxID');
      const teamPK = await Vault.getKey('teamPK');

      if (!teamFluxID || !teamPK) {
        log.error('teamFluxID and teamPK are required to decrypt enterprise apps');
        enterpriseAppsToDecrypt.forEach((app) => unresolvedEnterpriseAppNames.add(app.name));
        decryptFailures = enterpriseAppsToDecrypt.length;
      } else {
        let arcaneSessions = [];
        try {
          arcaneSessions = await enterpriseCrypto.createArcaneNodeSessions(
            teamFluxID,
            teamPK,
            enterpriseCrypto.ARCANE_NODE_RETRY_COUNT,
          );
          log.info(`Decrypting ${enterpriseAppsToDecrypt.length} new or changed enterprise apps`);
        } catch (error) {
          log.error('Failed to prepare ArcaneOS node sessions for enterprise decryption:', error.message);
          enterpriseAppsToDecrypt.forEach((app) => unresolvedEnterpriseAppNames.add(app.name));
          decryptFailures = enterpriseAppsToDecrypt.length;
        }

        if (arcaneSessions.length === 0 && decryptFailures === 0) {
          log.error('ArcaneOS session discovery returned no usable sessions');
          enterpriseAppsToDecrypt.forEach((app) => unresolvedEnterpriseAppNames.add(app.name));
          decryptFailures = enterpriseAppsToDecrypt.length;
        } else if (arcaneSessions.length > 0) {
          for (let i = 0; i < enterpriseAppsToDecrypt.length; i += 1) {
            const app = enterpriseAppsToDecrypt[i];
            try {
              const decryptedFields = await enterpriseCrypto.decryptEnterpriseSpecWithRetry(
                app,
                arcaneSessions,
              );
              const decryptedSpec = {
                ...app,
                compose: decryptedFields.compose || [],
                contacts: decryptedFields.contacts || [],
              };
              const entry = enterpriseCrypto.buildSyncthingAppEntry(decryptedSpec);
              if (entry) appsWithSyncthing.push(entry);
              const cacheUpdate = enterpriseDiscoveryCache.buildCacheUpdate(app, entry);
              if (cacheUpdate) cacheUpdates.push(cacheUpdate);
            } catch (error) {
              decryptFailures += 1;
              unresolvedEnterpriseAppNames.add(app.name);
              log.warn(`Failed to decrypt enterprise app ${app.name} after ArcaneOS retries: ${error.message}`);
            }
          }
        }
      }
    }

    const discoverySummary = [
      `found=${appsWithSyncthing.length}`,
      `plainSpecs=${plainApps.length}`,
      `enterpriseSpecs=${enterpriseApps.length}`,
      `cacheHits=${cacheHits}`,
      `bootstrapped=${bootstrapHits}`,
      `decrypted=${enterpriseAppsToDecrypt.length - decryptFailures}`,
      `decryptFailures=${decryptFailures}`,
    ].join(', ');
    log.info(`Syncthing discovery complete: ${discoverySummary}`);
    return {
      apps: appsWithSyncthing,
      cacheUpdates,
      currentEnterpriseAppNames,
      unresolvedEnterpriseAppNames,
    };
  } catch (e) {
    log.error('Failed to fetch global app specifications', e);
    return false;
  }
}

async function getAppsWithSyncthing() {
  const discovery = await discoverAppsWithSyncthing();
  return discovery ? discovery.apps : false;
}

/**
 * Creates a backup task for an application and retrieves backup lists for each component.
 *
 * @async
 * @param {string} node - The node URL (e.g., 'https://68-69-240-14-16157.node.api.runonflux.io')
 * @param {string} zelidAuth - The authentication string
 * @param {string} appname - The application name
 * @param {Array} componentList - Array of component names
 * @returns {Promise<Object|null>} - Combined backup data for all components, or null if failed
 */
async function createBackupTaskOnNode(node, zelidAuth, appname, componentList) {
  const diagnostics = [];
  const createEndpoint = `${node}/apps/appendbackuptask`;
  try {
    log.info(`Creating backup task for ${appname} with components: ${JSON.stringify(componentList)}`);

    // Prepare backup payload
    const backupPayload = {
      appname,
      backup: componentList.map((component) => ({
        component,
        backup: true,
      })),
    };

    // Make the backup request
    const backupResponse = await axios({
      method: 'post',
      url: createEndpoint,
      headers: {
        'Content-Type': 'application/json',
        zelidauth: zelidAuth,
      },
      data: backupPayload,
      timeout: 300000, // 5 minutes timeout for backup process
      httpsAgent,
    });

    if (!backupResponse.data) {
      throw new Error('No response data from backup task creation');
    }
    if (backupResponse.data.status === 'error') {
      throw new Error(
        getSafeApiMessage(backupResponse.data) || 'Flux node rejected the backup task',
      );
    }

    diagnostics.push({
      check: 'Flux node backup creation',
      outcome: 'success',
      endpoint: createEndpoint,
      node,
      httpStatus: backupResponse.status,
      detail: 'Node accepted the backup task',
    });

    log.info(`Backup task created successfully for ${appname}`);

    // Wait longer for backup creation to ensure files are generated
    log.info(`Waiting for backup files to be created for ${appname}...`);
    await new Promise((resolve) => { setTimeout(resolve, 5 * 60 * 1000); }); // Wait 5 minutes

    // Get volume mount paths for all components upfront
    const componentMounts = {};
    for (let i = 0; i < componentList.length; i += 1) {
      const component = componentList[i];
      try {
        const volumeEndpoint = `${node}/backup/getvolumedataofcomponent/${appname}/${component}/B/0/mount`;
        const volumeResponse = await axios({
          method: 'get',
          url: volumeEndpoint,
          headers: {
            zelidauth: zelidAuth,
          },
          timeout: 10000,
          httpsAgent,
        });

        if (volumeResponse.data && volumeResponse.data.status === 'success' && volumeResponse.data.data.mount) {
          componentMounts[component] = volumeResponse.data.data.mount;
          log.info(`Got mount path for component ${component}: ${componentMounts[component]}`);
        } else {
          diagnostics.push({
            check: `Flux volume lookup (${component})`,
            outcome: 'failed',
            endpoint: volumeEndpoint,
            node,
            httpStatus: volumeResponse.status,
            detail: getSafeApiMessage(volumeResponse.data) || 'Mount path was not returned',
          });
          log.error(`Failed to get mount path for component ${component}`);
        }
      } catch (error) {
        diagnostics.push({
          check: `Flux volume lookup (${component})`,
          outcome: 'failed',
          endpoint: `${node}/backup/getvolumedataofcomponent/${appname}/${component}/B/0/mount`,
          node,
          ...getRequestFailure(error),
        });
        log.error(`Error fetching volume data for component ${component}: ${error.message}`);
      }
    }

    // Verify backup creation completed by checking task status
    let backupReady = false;
    let statusCheckCount = 0;
    let lastReadinessFailure = null;
    let readinessEndpoint = null;
    const maxStatusChecks = 20; // Maximum 20 checks * 5 seconds = 100 seconds total

    while (!backupReady && statusCheckCount < maxStatusChecks) {
      try {
        // Check if backup files exist for the first component as indicator
        const firstComponent = componentList[0];
        const firstMount = componentMounts[firstComponent];

        if (!firstMount) {
          throw new Error(`No mount path available for component ${firstComponent}`);
        }

        const testPath = encodeURIComponent(`${firstMount}/backup/local`);
        const testUrl = `${node}/backup/getlocalbackuplist/${testPath}/B/0/true/${appname}`;
        readinessEndpoint = testUrl;

        const testResponse = await axios({
          method: 'get',
          url: testUrl,
          headers: {
            zelidauth: zelidAuth,
          },
          timeout: 10000,
          httpsAgent,
        });

        if (testResponse.data && testResponse.data.status === 'success' && testResponse.data.data.length > 0) {
          // Found backup files, proceed
          backupReady = true;
          log.info(`Backup files detected for ${appname}, proceeding to retrieve all components`);
        } else {
          lastReadinessFailure = {
            check: 'Flux backup readiness',
            outcome: 'failed',
            endpoint: testUrl,
            node,
            httpStatus: testResponse.status,
            detail: getSafeApiMessage(testResponse.data) || 'Backup file list was empty',
          };
          statusCheckCount += 1;
          if (statusCheckCount < maxStatusChecks) {
            log.info(`Waiting for backup creation to complete (check ${statusCheckCount}/${maxStatusChecks})...`);
            await new Promise((resolve) => { setTimeout(resolve, 5000); });
          }
        }
      } catch (error) {
        lastReadinessFailure = {
          check: 'Flux backup readiness',
          outcome: 'failed',
          endpoint: readinessEndpoint,
          node,
          ...getRequestFailure(error),
        };
        statusCheckCount += 1;
        if (statusCheckCount < maxStatusChecks) {
          log.info(`Backup not ready yet (check ${statusCheckCount}/${maxStatusChecks}): ${error.message}`);
          await new Promise((resolve) => { setTimeout(resolve, 5000); });
        }
      }
    }

    if (!backupReady) {
      diagnostics.push(lastReadinessFailure || {
        check: 'Flux backup readiness',
        outcome: 'failed',
        node,
        detail: `Backup files were not detected after ${maxStatusChecks} checks`,
      });
      log.warn(`Backup creation may not have completed for ${appname} after ${maxStatusChecks} checks, proceeding anyway`);
    }

    // Get backup lists for each component
    const backupResults = [];
    const maxRetries = 10;

    for (let i = 0; i < componentList.length; i += 1) {
      const component = componentList[i];
      let componentBackupData = null;
      let retryCount = 0;
      let lastComponentFailure = null;
      let backupListEndpoint = null;

      while (retryCount < maxRetries && !componentBackupData) {
        try {
          // Use the cached mount path for this component
          const mount = componentMounts[component];
          if (!mount) {
            throw new Error(`No mount path available for component ${component}`);
          }

          const backupPath = encodeURIComponent(`${mount}/backup/local`);
          const backupListUrl = `${node}/backup/getlocalbackuplist/${backupPath}/B/0/true/${appname}`;
          backupListEndpoint = backupListUrl;

          log.info(`Fetching backup list for component ${component}, attempt ${retryCount + 1}, mount: ${mount}`);

          const backupListResponse = await axios({
            method: 'get',
            url: backupListUrl,
            headers: {
              zelidauth: zelidAuth,
            },
            timeout: 30000, // 30 seconds timeout
          });

          if (backupListResponse.data && backupListResponse.data.status === 'success') {
            const responseData = backupListResponse.data.data;
            log.info(`Backup list response for component ${component}: received ${Array.isArray(responseData) ? responseData.length : 0} files`);

            // Log all file names received for debugging
            if (Array.isArray(responseData) && responseData.length > 0) {
              const fileNames = responseData.map((f) => f.name).join(', ');
              log.info(`Files in backup directory for ${component}: ${fileNames}`);
            } else {
              log.warn(`No files found in backup directory for component ${component}, attempt ${retryCount + 1}`);
            }

            // Filter backup files for this specific component and get the latest one
            const expectedPattern = `backup_${component}.tar.gz`;
            const allBackups = responseData.filter((backup) => backup.name.toLowerCase().includes(expectedPattern.toLowerCase()));

            log.info(`Filtering for pattern "${expectedPattern}": found ${allBackups.length} matching backup(s)`);

            if (allBackups.length > 0) {
              // Sort by create timestamp (descending) and get the latest
              const latestBackup = allBackups.sort((a, b) => Number(b.create) - Number(a.create))[0];

              const encodedFileName = encodeURIComponent(latestBackup.name);
              componentBackupData = {
                component,
                backups: latestBackup,
                host: `${node}/backup/downloadlocalfile/${backupPath}%2F${encodedFileName}/${appname}`,
              };

              log.info(`Found ${allBackups.length} backup(s) for component ${component}, selected latest: ${latestBackup.name} (created: ${latestBackup.create})`);
            } else {
              log.warn(`No backups matching pattern "${expectedPattern}" for component ${component}, attempt ${retryCount + 1}`);
            }
          } else {
            lastComponentFailure = {
              check: `Flux backup list (${component})`,
              outcome: 'failed',
              endpoint: backupListUrl,
              node,
              httpStatus: backupListResponse.status,
              detail: getSafeApiMessage(backupListResponse.data) || 'Node rejected backup list request',
            };
            log.warn(`Backup list request failed for component ${component}, attempt ${retryCount + 1}. Status: ${backupListResponse.data?.status}, Message: ${backupListResponse.data?.data || 'unknown'}`);
          }
        } catch (error) {
          lastComponentFailure = {
            check: `Flux backup list (${component})`,
            outcome: 'failed',
            endpoint: backupListEndpoint,
            node,
            ...getRequestFailure(error),
          };
          log.error(`Error fetching backup list for component ${component}, attempt ${retryCount + 1}: ${error.message}`);
        }

        retryCount += 1;

        // Wait before retry
        if (retryCount < maxRetries && !componentBackupData) {
          await new Promise((resolve) => { setTimeout(resolve, 5000); });
        }
      }

      if (componentBackupData) {
        backupResults.push(componentBackupData);
      } else {
        const componentFailure = lastComponentFailure || {
          check: `Flux backup list (${component})`,
          outcome: 'failed',
          node,
          detail: `No matching backup file after ${maxRetries} attempts`,
        };
        diagnostics.push(componentFailure);
        log.error(`Failed to get backup data for component ${component} after ${maxRetries} attempts`);
        backupResults.push({
          component,
          backups: [],
          error: `${componentFailure.detail}; node=${node}${componentFailure.endpoint ? `; endpoint=${componentFailure.endpoint}` : ''}`,
        });
      }
    }

    const result = {
      appname,
      status: 'completed',
      components: backupResults,
      totalComponents: componentList.length,
      successfulComponents: backupResults.filter((r) => r.backups && r.backups.length > 0).length,
      diagnostics,
    };

    log.info(`Backup task completed for ${appname}. ${result.successfulComponents}/${result.totalComponents} components successful`);
    return result;
  } catch (error) {
    diagnostics.push({
      check: 'Flux node backup creation',
      outcome: 'failed',
      endpoint: createEndpoint,
      node,
      ...getRequestFailure(error),
    });
    log.error(`Error creating backup task for ${appname}: ${error.message}`, { stack: error.stack });
    return {
      appname,
      status: 'failed',
      components: [],
      error: error.message,
      diagnostics,
    };
  }
}

module.exports = {
  getAppSpecs,
  getBlockHeight,
  verifyAppOwner,
  getAppOwnerDetailed,
  getAppOwner,
  getAppExpireHeight,
  verifyLoginDetailed,
  verifyLogin,
  discoverAppsWithSyncthing,
  getAppsWithSyncthing,
  isAppExpiredInGlobalSpecs,
  getSecondaryNodeSelection,
  getSecondaryNodeFromHAProxy,
  createBackupTaskOnNode,
};
