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
const backupProfiles = require('./utils/backupProfiles');

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

  // eslint-disable-next-line no-use-before-define
  if (await isTeamFluxId(owner)) {
    log.info(`App ${appname} verified as owned by a team Flux ID`);
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

/**
 * The primary's API address (ip:port): its IP from FDM appips, its port from
 * the location API. Null when either cannot say, or when several locations
 * share that IP and the port cannot be told apart.
 */
async function getPrimaryNodeAddress(appname, diagnostics) {
  const primaryIp = await getPrimaryNodeIp(appname, diagnostics);
  if (!primaryIp) return null;
  const locationUrl = `https://api.runonflux.io/apps/location/${appname}`;
  const response = await axios.get(locationUrl, { httpsAgent, timeout: 30000 });
  const locations = response.data?.status === 'success' && Array.isArray(response.data.data)
    ? response.data.data
    : [];
  const matching = locations.filter((location) => location?.ip && extractNodeIp(location.ip) === primaryIp);
  return matching.length === 1 ? formatLocationNode(matching[0].ip) : null;
}

async function getSecondaryNodeFromLocationApi(
  appname,
  primaryIp,
  diagnostics,
  excludedNodes = new Set(),
) {
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
      const alternativeLocations = locations.filter(
        (location) => extractNodeIp(location.ip) !== primaryIp,
      );
      const alternativeLocation = alternativeLocations.find(
        (location) => !excludedNodes.has(formatLocationNode(location.ip)),
      ) || alternativeLocations[0];

      if (alternativeLocation) {
        const secondaryNode = formatLocationNode(alternativeLocation.ip);
        const reused = excludedNodes.has(secondaryNode);
        diagnostics.push({
          check: 'Flux location API',
          outcome: 'success',
          endpoint: locationUrl,
          node: secondaryNode,
          detail: reused
            ? `All distinct secondary locations were already attempted; retrying ${secondaryNode}`
            : `Selected an untried location different from primary ${primaryIp}`,
        });
        log.info(`${reused ? 'Reusing' : 'Found'} secondary node from location API (primary ${primaryIp}): ${secondaryNode}`);
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
async function getSecondaryNodeSelection(appname, excludedNodes = new Set()) {
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
      if (secondaryNode && !excludedNodes.has(secondaryNode)) {
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

      if (secondaryNode) {
        diagnostics.push({
          check: 'FDM HAProxy statistics',
          outcome: 'skipped',
          endpoint: statsUrl,
          node: secondaryNode,
          detail: 'Previously attempted node was skipped while looking for another secondary',
        });
        log.info(`Skipping previously attempted HAProxy node for ${appname}: ${secondaryNode}`);
      }

      if (!secondaryNode) {
        diagnostics.push({
          check: 'FDM HAProxy statistics',
          outcome: 'failed',
          endpoint: statsUrl,
          httpStatus: response.status,
          detail: 'No UP backup node or second UP active node was present',
        });
        log.info(`HAProxy statistics for ${appname} did not yield a secondary node`);
      }
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
    excludedNodes,
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
      const apiMessage = getSafeApiMessage(response.data) || 'unspecified node API error';
      const reason = 'Selected Flux node API is unavailable for backup authentication: login phrase endpoint returned an error response';
      log.error(`Failed to get login phrase from Flux API: ${reason}; nodeMessage=${apiMessage}`);
      return {
        phrase: null,
        reason,
        diagnostic: {
          check: 'Flux node login phrase',
          outcome: 'failed',
          endpoint,
          node,
          httpStatus: response.status,
          detail: 'Node API responded but did not provide a login phrase',
        },
      };
    }
    if (!response.data.data) {
      const reason = 'Selected Flux node API is unavailable for backup authentication: login phrase response was empty';
      return {
        phrase: null,
        reason,
        diagnostic: {
          check: 'Flux node login phrase',
          outcome: 'failed',
          endpoint,
          node,
          httpStatus: response.status,
          detail: 'Node API responded but did not provide a login phrase',
        },
      };
    }
    return {
      phrase: response.data.data,
      reason: null,
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
    const requestFailure = getRequestFailure(error);
    const reason = error.response
      ? `Selected Flux node API is unavailable for backup authentication: HTTP ${error.response.status}`
      : `Selected Flux node API is unreachable: ${requestFailure.detail}`;
    return {
      phrase: null,
      reason,
      diagnostic: {
        check: 'Flux node login phrase',
        outcome: 'failed',
        endpoint,
        node,
        ...requestFailure,
        detail: reason,
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
        reason: loginPhraseResult.reason || loginPhraseResult.diagnostic.detail,
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

async function getTeamCredentials() {
  const [primaryId, primaryKey, secondaryId, secondaryKey] = await Promise.all([
    Vault.getKey('teamFluxID'),
    Vault.getKey('teamPK'),
    Vault.getKey('teamFluxID2'),
    Vault.getKey('teamPK2'),
  ]);
  const credentials = [];
  if (primaryId && primaryKey) {
    credentials.push({ label: 'primary', zelid: primaryId, privateKey: primaryKey });
  }
  if (secondaryId && secondaryKey
    && (secondaryId !== primaryId || secondaryKey !== primaryKey)) {
    credentials.push({ label: 'secondary', zelid: secondaryId, privateKey: secondaryKey });
  }
  return credentials;
}

async function isTeamFluxId(zelid) {
  if (!zelid) return false;
  const [primaryId, secondaryId] = await Promise.all([
    Vault.getKey('teamFluxID'),
    Vault.getKey('teamFluxID2'),
  ]);
  return zelid === primaryId || zelid === secondaryId;
}

function labelLoginDiagnostics(diagnostics, credentialLabel) {
  return (diagnostics || []).map((diagnostic) => ({
    ...diagnostic,
    check: `${diagnostic.check} (${credentialLabel} credentials)`,
    credential: credentialLabel,
  }));
}

function reachedCredentialVerification(result) {
  return (result.diagnostics || []).some((diagnostic) => (
    diagnostic.check === 'Flux node login phrase' && diagnostic.outcome === 'success'
  ));
}

function isExplicitAuthorizationFailure(result) {
  const diagnostics = result?.diagnostics || [];
  if (diagnostics.some((diagnostic) => (
    diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403
  ))) return true;

  const details = [
    result?.error,
    ...diagnostics.map((diagnostic) => diagnostic.detail),
  ].filter(Boolean).join(' ');
  return /unauthori[sz]ed|access denied|forbidden|session expired/i.test(details);
}

async function verifyTeamLoginDetailed(node, verifier = verifyLoginDetailed) {
  const credentials = await getTeamCredentials();
  if (credentials.length === 0) {
    return {
      zelidAuth: null,
      reason: 'No complete team Flux credentials are configured',
      diagnostics: [{
        check: 'Team Flux credentials',
        outcome: 'failed',
        node,
        detail: 'Configure teamFluxID/teamPK or teamFluxID2/teamPK2',
      }],
    };
  }

  const diagnostics = [];
  let lastResult = null;
  for (let index = 0; index < credentials.length; index += 1) {
    const credential = credentials[index];
    // eslint-disable-next-line no-await-in-loop
    const result = await verifier(credential.zelid, credential.privateKey, node);
    lastResult = result;
    diagnostics.push(...labelLoginDiagnostics(result.diagnostics, credential.label));
    if (result.zelidAuth) {
      if (credential.label === 'secondary') {
        log.info(`Authenticated with ${node} using secondary team credentials`);
      }
      return {
        ...result,
        diagnostics,
        credential: credential.label,
      };
    }

    const hasAnotherCredential = index + 1 < credentials.length;
    if (!hasAnotherCredential || !reachedCredentialVerification(result)) break;
    log.warn(`Primary team authentication was rejected by ${node}; trying secondary credentials`);
  }

  return {
    zelidAuth: null,
    reason: lastResult?.reason || `Failed to authenticate with ${node}`,
    diagnostics,
    credential: null,
  };
}

async function verifyTeamLogin(node) {
  const result = await verifyTeamLoginDetailed(node);
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
 * Plain apps are checked directly. Enterprise apps (encrypted compose) have their
 * AES key unwrapped by SAS over mTLS, then are decrypted locally before checking
 * containerData prefixes s:, r:, or g:.
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
      try {
        await enterpriseCrypto.assertSasConfigured();
      } catch (error) {
        log.error(`SAS enterprise decryption is unavailable: ${error.message}`);
        enterpriseAppsToDecrypt.forEach((app) => unresolvedEnterpriseAppNames.add(app.name));
        decryptFailures = enterpriseAppsToDecrypt.length;
      }

      if (decryptFailures === 0) {
        log.info(`Decrypting ${enterpriseAppsToDecrypt.length} new or changed enterprise apps through SAS`);
        for (let i = 0; i < enterpriseAppsToDecrypt.length; i += 1) {
          const app = enterpriseAppsToDecrypt[i];
          try {
            const decryptedFields = await enterpriseCrypto.decryptEnterpriseSpecWithSas(app);
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
            log.warn(`Failed to decrypt enterprise app ${app.name} through SAS: ${error.message}`);
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

const FILE_OPERATION_TERMINAL_STATES = ['Succeeded', 'Failed', 'Canceled', 'Evicted'];
const FILE_OPERATION_TIMEOUT_MS = 10 * 60 * 1000;
const FILE_OPERATION_MAX_BUSY_RETRIES = 12;

function isMissingPathResponse(data) {
  const code = data?.data?.code || data?.code;
  if (code === 'ENOENT') return true;
  const message = getSafeApiMessage(data) || '';
  return /ENOENT|no such file|does not exist/i.test(message);
}

function retryAfterMs(headers, fallbackSeconds = 5) {
  const seconds = Number(headers?.['retry-after']);
  return (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : fallbackSeconds) * 1000;
}

/**
 * Ask the node for the full appdata archive of each component
 * (appendbackuptask), and give it time to write it.
 */
async function requestFullBackupOnNode(node, zelidAuth, appname, componentList, diagnostics) {
  const createEndpoint = `${node}/apps/appendbackuptask`;
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
}

/**
 * List a directory of a component's volume.
 *
 * @param {string} folder - path relative to the volume root (appdata/...)
 * @returns {Promise<Array|null>} the entries, or null when the directory does not exist
 * @throws when the node cannot answer, so a transient failure is never read as "missing"
 */
async function listVolumeFolder(node, zelidAuth, appname, component, folder) {
  const endpoint = `${node}/apps/getfolderinfo/${appname}/${component}/${encodeURIComponent(folder)}`;
  const response = await axios({
    method: 'get',
    url: endpoint,
    headers: { zelidauth: zelidAuth },
    timeout: 30000,
    httpsAgent,
  });
  const { data } = response;
  if (data?.status === 'success' && Array.isArray(data.data)) return data.data;
  if (data?.status === 'error' && isMissingPathResponse(data)) return null;
  const error = new Error(`Could not list ${folder}: ${getSafeApiMessage(data) || 'unexpected response'}`);
  error.endpoint = endpoint;
  throw error;
}

/** Create a directory on the volume; one that already exists is fine. */
async function ensureVolumeFolder(node, zelidAuth, appname, component, folder) {
  const endpoint = `${node}/apps/createfolder/${appname}/${component}/${encodeURIComponent(folder)}`;
  const response = await axios({
    method: 'get',
    url: endpoint,
    headers: { zelidauth: zelidAuth },
    timeout: 60000,
    httpsAgent,
    validateStatus: () => true,
  });
  const { data } = response;
  if (data?.status === 'success') return;
  const code = data?.data?.code || data?.code;
  const message = getSafeApiMessage(data) || `HTTP ${response.status}`;
  if (code === 'EEXIST' || /already exists|file exists/i.test(message)) return;
  const error = new Error(`Could not create ${folder}: ${message}`);
  error.endpoint = endpoint;
  throw error;
}

/**
 * Run one of FluxOS's volume file operations and wait for it to finish.
 *
 * The node answers 200 when the operation finished inline, 202 with a job to
 * poll when it continues in the background, and 503 with Retry-After when
 * another operation holds this app's volume. A job's outcome is its status
 * field, never the HTTP code: a failed job is a 200 that says Failed.
 *
 * @param {string} label - the operation's name, which starts every error message
 * @param {object} request - the axios request, without headers or agent
 * @param {function(object): void} [onAnswer] - sees the final non-503 answer
 *   first, to throw for a status this operation gives its own meaning
 * @throws when the node refuses, the job does not succeed, or it outlives
 *   FILE_OPERATION_TIMEOUT_MS
 */
async function runVolumeOperation(node, zelidAuth, label, request, onAnswer = () => {}) {
  let response;
  for (let attempt = 0; ; attempt += 1) {
    response = await axios({
      ...request,
      headers: { ...(request.data ? { 'Content-Type': 'application/json' } : {}), zelidauth: zelidAuth },
      timeout: 60000,
      httpsAgent,
      validateStatus: () => true,
    });
    if (response.status !== 503 || attempt >= FILE_OPERATION_MAX_BUSY_RETRIES) break;
    const waitMs = retryAfterMs(response.headers);
    await new Promise((resolve) => { setTimeout(resolve, waitMs); });
  }

  const body = response.data;
  onAnswer(response);
  if (response.status === 202 && body?.data?.jobId) {
    const offered = body.data.statusUrl;
    // Only a path on this node: an offered URL naming another host would carry the zelidauth there.
    const statusPath = typeof offered === 'string' && offered.startsWith('/') && !offered.startsWith('//')
      ? offered
      : `/apps/operations/${body.data.jobId}`;
    const giveUpAt = Date.now() + FILE_OPERATION_TIMEOUT_MS;
    let failures = 0;
    while (Date.now() < giveUpAt) {
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
      try {
        const poll = await axios({
          method: 'get',
          url: `${node}${statusPath}`,
          headers: { zelidauth: zelidAuth },
          timeout: 30000,
          httpsAgent,
        });
        const view = poll.data?.data || {};
        if (FILE_OPERATION_TERMINAL_STATES.includes(view.status)) {
          if (view.status === 'Succeeded') return;
          const failed = new Error(`${label} ${view.status}: ${view.error?.detail || view.error?.title || 'no detail'}`);
          failed.terminal = true;
          throw failed;
        }
        failures = 0;
      } catch (error) {
        if (error.terminal) throw error;
        failures += 1;
        if (failures >= 3) throw error;
      }
    }
    throw new Error(`${label} did not finish within ${FILE_OPERATION_TIMEOUT_MS / 60000} minutes`);
  }
  if (response.status < 200 || response.status >= 300 || body?.status === 'error') {
    throw new Error(`${label} refused: ${getSafeApiMessage(body) || `HTTP ${response.status}`}`);
  }
}

/** Run compressobject and wait for it to finish. */
async function compressOnNode(node, zelidAuth, payload) {
  await runVolumeOperation(node, zelidAuth, 'compressobject', {
    method: 'post',
    url: `${node}/apps/compressobject`,
    data: payload,
  }, (response) => {
    if (response.status === 404) {
      throw new Error('Node does not support compressobject (FluxOS older than 8.18.0)');
    }
  });
}

/**
 * Delete a file or folder of a component's volume. One already gone is fine:
 * the node removes with rm -rf, which succeeds on a missing path.
 *
 * @param {string} object - path relative to the volume root
 * @throws when the node does not confirm the removal
 */
async function removeVolumeObject(node, zelidAuth, appname, component, object) {
  const endpoint = `${node}/apps/removeobject/${appname}/${component}/${encodeURIComponent(object)}`;
  try {
    await runVolumeOperation(node, zelidAuth, 'removeobject', { method: 'get', url: endpoint });
  } catch (error) {
    error.endpoint = endpoint;
    throw error;
  }
}

/** The empty folder every partial archive starts with; see backupProfiles.PROFILE_MARKER_DIR. */
const PROFILE_MARKER = `appdata/${backupProfiles.PROFILE_MARKER_DIR}`;
/** How often, and how many times, to look for a marker made on the primary to reach the standby. */
const PROFILE_MARKER_SYNC_WAIT_MS = 15 * 1000;
const PROFILE_MARKER_SYNC_CHECKS = 8;

/** FluxOS 8.21+ refusing a write on a standby, whose copy follows the primary's. */
function isReadOnlyCopyRefusal(error) {
  return /read-only copy/i.test(error?.message || '');
}

/**
 * Make sure the marker is on the node the archive is written on.
 *
 * Since FluxOS 8.21 a standby refuses writes into appdata, which is the
 * replicated part of its volume: syncthing would never send them and the
 * standby reverts them. The marker is then made on the primary, which owns
 * the copy, and arrives on the standby like any other file. Being an empty
 * folder, it is harmless to the game, and once there it stays: later backups
 * find it and ask the primary for nothing. A full backup carries it too, and
 * is still told apart by its first entry, `./`.
 *
 * @param {function(): Promise<{node: string, zelidAuth: string}>} [reachPrimary]
 * @throws when the marker cannot be put on this node
 */
async function ensureProfileMarker(node, zelidAuth, appname, component, reachPrimary) {
  const present = () => listVolumeFolder(node, zelidAuth, appname, component, PROFILE_MARKER);
  if (await present()) return;
  try {
    // Accepted by a primary, a standby on FluxOS older than 8.21, and an app with no synced copy.
    await ensureVolumeFolder(node, zelidAuth, appname, component, PROFILE_MARKER);
    return;
  } catch (error) {
    if (!isReadOnlyCopyRefusal(error) || !reachPrimary) throw error;
  }
  const primary = await reachPrimary();
  await ensureVolumeFolder(primary.node, primary.zelidAuth, appname, component, PROFILE_MARKER);
  for (let check = 0; check < PROFILE_MARKER_SYNC_CHECKS; check += 1) {
    await new Promise((resolve) => { setTimeout(resolve, PROFILE_MARKER_SYNC_WAIT_MS); });
    if (await present()) return;
  }
  throw new Error(`${PROFILE_MARKER} was made on the primary ${primary.node} but had not reached this node after ${(PROFILE_MARKER_SYNC_WAIT_MS * PROFILE_MARKER_SYNC_CHECKS) / 1000}s`);
}

/**
 * How long to wait before listing again a volume whose files were still
 * arriving. Syncthing delivers a save in seconds; this leaves it a wide margin
 * without holding the backup worker long.
 */
const PROFILE_UNSETTLED_WAIT_MS = 90 * 1000;
/** Archives written before giving up on a volume that keeps changing under them. */
const PROFILE_ARCHIVE_ATTEMPTS = 2;

/**
 * Write a profile's partial archive where appendbackuptask writes the full one,
 * backup/local/backup_<component>.tar.gz, so everything after this - the
 * readiness check, the download and the upload - is the same for both.
 *
 * No stop is needed: backups are taken on the secondary, where a g: app's
 * container does not run. Syncthing still writes there, though, so the paths
 * are listed again once the archive is written: when anything changed, the
 * archive may hold half of a save, and it is written again from the new
 * listing. A listing whose `validate` finds a save still arriving (unsettled)
 * is listed again after PROFILE_UNSETTLED_WAIT_MS before giving up: the full
 * backup would only archive the same half-synced files, and fifty times more.
 *
 * @returns {Promise<{fits: boolean, archiveFailed?: boolean, changing?: boolean, reason?: string}>}
 *   fits:false when the app does not have the profile's layout, when the node
 *   could not write the partial archive (archiveFailed), or when the volume
 *   changed under every attempt (changing); the caller then takes the full
 *   backup in every case
 * @throws when the profile's paths cannot be listed, so a transient failure is
 *   retried on another node rather than read as a missing layout
 */
async function createProfiledArchiveOnNode(node, zelidAuth, appname, component, profile, diagnostics, reachPrimary = null) {
  const listAll = () => backupProfiles.collectProfileListings(
    profile,
    (folder) => listVolumeFolder(node, zelidAuth, appname, component, folder ? `appdata/${folder}` : 'appdata'),
  );
  // The plan for a listing, listed once more after a wait when its files were still arriving.
  const settle = async (first) => {
    let listed = first;
    let planned = backupProfiles.planProfiledArchive(profile, listed);
    if (!planned.fits && planned.unsettled) {
      log.info(`Backup profile ${profile.id} found ${appname}/${component} still syncing (${planned.reason}); listing again in ${PROFILE_UNSETTLED_WAIT_MS / 1000}s`);
      await new Promise((resolve) => { setTimeout(resolve, PROFILE_UNSETTLED_WAIT_MS); });
      listed = await listAll();
      planned = backupProfiles.planProfiledArchive(profile, listed);
    }
    return { listed, planned };
  };
  let { listed: listings, planned: plan } = await settle(await listAll());
  if (!plan.fits) return plan;

  // From here on a failure is the node not writing the partial archive: a
  // FluxOS older than 8.18 without compressobject, a refused or failed job.
  // appendbackuptask can still take the full one, as it did before
  // profiles existed. Never a reason to leave the app with no backup at all.
  try {
    await ensureProfileMarker(node, zelidAuth, appname, component, reachPrimary);
    // appendbackuptask makes backup/local itself; on a node that never ran one it is not there yet.
    await ensureVolumeFolder(node, zelidAuth, appname, component, 'backup');
    await ensureVolumeFolder(node, zelidAuth, appname, component, 'backup/local');
  } catch (error) {
    return { fits: false, archiveFailed: true, reason: error?.message || String(error) };
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      await compressOnNode(node, zelidAuth, {
        appname,
        component,
        source: plan.sources,
        destination: `backup/local/backup_${component.toLowerCase()}.tar.gz`,
        overwrite: true,
      });
    } catch (error) {
      return { fits: false, archiveFailed: true, reason: error?.message || String(error) };
    }

    const after = await listAll();
    if (backupProfiles.sameListings(listings, after, profile.ignoreChanges)) break;
    if (attempt >= PROFILE_ARCHIVE_ATTEMPTS) {
      return { fits: false, changing: true, reason: `the files changed while archiving, ${attempt} times` };
    }
    log.info(`Backup profile ${profile.id}: ${appname}/${component} changed while archiving; writing the archive again`);
    ({ listed: listings, planned: plan } = await settle(after));
    if (!plan.fits) return plan;
  }

  diagnostics.push({
    check: `Flux node profiled archive (${component})`,
    outcome: 'success',
    endpoint: `${node}/apps/compressobject`,
    node,
    detail: `${profile.id}: ${plan.sources.join(', ')}`,
  });
  log.info(`Profiled archive ${profile.id} written for ${appname}/${component}: ${plan.sources.join(', ')}`);
  return { fits: true };
}

/**
 * Creates a backup task for an application and retrieves backup lists for each component.
 *
 * @async
 * @param {string} node - The node URL (e.g., 'https://68-69-240-14-16157.node.api.runonflux.io')
 * @param {string} zelidAuth - The authentication string
 * @param {string} appname - The application name
 * @param {Array} componentList - Array of component names
 * @param {Object} [options]
 * @param {boolean} [options.onPrimary] - the node is the primary, where the
 *   app's container runs: only the profile's partial archive is taken, never
 *   the full backup, which stops the app for the customer
 * @returns {Promise<Object|null>} - Combined backup data for all components, or null if failed
 */
async function createBackupTaskOnNode(node, zelidAuth, appname, componentList, componentProfiles = null, reachPrimary = null, options = {}) {
  const diagnostics = [];
  const createEndpoint = `${node}/apps/appendbackuptask`;
  const usedProfiles = {};
  const onPrimary = options.onPrimary === true;
  try {
    log.info(`Creating backup task for ${appname} with components: ${JSON.stringify(componentList)}${onPrimary ? ' on the primary' : ''}`);

    if (onPrimary && !componentProfiles) {
      throw new Error('A backup on the primary needs a backup profile; the full backup would stop the server');
    }

    let profiled = false;
    if (componentProfiles) {
      profiled = true;
      for (let i = 0; i < componentList.length && profiled; i += 1) {
        const component = componentList[i];
        const profile = componentProfiles[component];
        const outcome = await createProfiledArchiveOnNode(node, zelidAuth, appname, component, profile, diagnostics, reachPrimary);
        if (outcome.fits) {
          usedProfiles[component] = profile.id;
        } else {
          let why = 'does not fit';
          if (outcome.archiveFailed) why = 'archive failed';
          else if (outcome.changing) why = 'kept changing';
          else if (outcome.unsettled) why = 'still syncing';
          log.info(`Backup profile ${profile.id} ${why} for ${appname}/${component} (${outcome.reason}); taking the full backup instead`);
          diagnostics.push({
            check: `Backup profile (${component})`,
            outcome: 'skipped',
            node,
            detail: `${profile.id} ${why}: ${outcome.reason}`,
          });
          profiled = false;
        }
      }
      if (!profiled) {
        Object.keys(usedProfiles).forEach((component) => { delete usedProfiles[component]; });
        // A partial archive may already sit where the full one goes: written by
        // this attempt before the volume changed under it, or by an earlier run
        // on this node. appendbackuptask only replaces it once it has stopped
        // the app, and it can refuse before that in its streamed answer, which
        // reads as success here; what follows would then upload the partial
        // archive as a full one, and a full one is restored over a wiped
        // appdata. Cleared first, so a refusal leaves nothing to pick up. A
        // node that cannot clear it fails this attempt, which moves on to
        // another node.
        for (let i = 0; i < componentList.length; i += 1) {
          await removeVolumeObject(node, zelidAuth, appname, componentList[i], `backup/local/backup_${componentList[i].toLowerCase()}.tar.gz`);
        }
        if (onPrimary) {
          const skipped = diagnostics.filter((diagnostic) => diagnostic.outcome === 'skipped').pop();
          throw new Error(`Backup profile could not be used on the primary (${skipped?.detail || 'no detail'}); the full backup would stop the server`);
        }
      }
    }

    if (!profiled) {
      await requestFullBackupOnNode(node, zelidAuth, appname, componentList, diagnostics);
    }

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
                profile: usedProfiles[component] || null,
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
      // A profile's listing or the clearing of the archive slot names its own.
      endpoint: error?.endpoint || createEndpoint,
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

async function createBackupTaskWithTeamCredentials(
  node,
  appname,
  componentList,
  verifier = verifyLoginDetailed,
  backupCreator = createBackupTaskOnNode,
  componentProfiles = null,
  options = {},
) {
  const credentials = await getTeamCredentials();
  if (credentials.length === 0) {
    return {
      appname,
      status: 'failed',
      components: [],
      error: 'No complete team Flux credentials are configured',
      failureStage: 'node_auth',
      diagnostics: [{
        check: 'Team Flux credentials',
        outcome: 'failed',
        node,
        detail: 'Configure teamFluxID/teamPK or teamFluxID2/teamPK2',
      }],
    };
  }

  const diagnostics = [];
  let lastResult = null;
  let failureStage = 'node_auth';

  for (let index = 0; index < credentials.length; index += 1) {
    const credential = credentials[index];
    // eslint-disable-next-line no-await-in-loop
    const loginResult = await verifier(credential.zelid, credential.privateKey, node);
    diagnostics.push(...labelLoginDiagnostics(loginResult.diagnostics, credential.label));

    if (!loginResult.zelidAuth) {
      lastResult = {
        appname,
        status: 'failed',
        components: [],
        error: loginResult.reason || `Failed to authenticate with ${node}`,
      };
      const hasAnotherCredential = index + 1 < credentials.length;
      if (!hasAnotherCredential || !reachedCredentialVerification(loginResult)) break;
      log.warn(`Team authentication with ${credential.label} credentials was rejected by ${node}; trying the next credentials`);
      // eslint-disable-next-line no-continue
      continue;
    }

    // A profiled backup may need the primary for its marker (see
    // ensureProfileMarker), reached with the credential the standby accepted.
    // Asked for at most once, and only when needed. On the primary the marker
    // is made in place.
    let primaryAccess = null;
    const reachPrimary = componentProfiles && !options.onPrimary ? () => {
      primaryAccess = primaryAccess || (async () => {
        const address = await getPrimaryNodeAddress(appname, []);
        if (!address) throw new Error('the primary node could not be identified');
        const primaryNode = `http://${address}`;
        if (primaryNode === node) throw new Error(`${node} is the primary itself`);
        const primaryLogin = await verifier(credential.zelid, credential.privateKey, primaryNode);
        if (!primaryLogin.zelidAuth) {
          throw new Error(`could not log in on the primary ${primaryNode}: ${primaryLogin.reason || 'refused'}`);
        }
        return { node: primaryNode, zelidAuth: primaryLogin.zelidAuth };
      })();
      return primaryAccess;
    } : null;

    // eslint-disable-next-line no-await-in-loop
    const backupResult = await backupCreator(
      node,
      loginResult.zelidAuth,
      appname,
      componentList,
      componentProfiles,
      reachPrimary,
      options,
    );
    lastResult = backupResult;
    failureStage = 'create_backup';
    diagnostics.push(...labelLoginDiagnostics(backupResult?.diagnostics, credential.label));

    if (backupResult && backupResult.status !== 'failed' && backupResult.components) {
      if (credential.label === 'secondary') {
        log.info(`Backup creation for ${appname} authorized with secondary team credentials`);
      }
      return {
        ...backupResult,
        diagnostics,
        credential: credential.label,
      };
    }

    const hasAnotherCredential = index + 1 < credentials.length;
    if (!hasAnotherCredential || !isExplicitAuthorizationFailure(backupResult)) break;
    log.warn(`Backup creation for ${appname} was denied with ${credential.label} credentials; trying the next credentials`);
  }

  return {
    appname,
    status: 'failed',
    components: [],
    error: lastResult?.error || `Failed to create backup tasks on ${node}`,
    failureStage,
    diagnostics,
    credential: null,
  };
}

module.exports = {
  getAppSpecs,
  getBlockHeight,
  verifyAppOwner,
  getAppOwnerDetailed,
  getAppOwner,
  getAppExpireHeight,
  getLoginPhraseDetailed,
  verifyLoginDetailed,
  verifyLogin,
  getTeamCredentials,
  isTeamFluxId,
  verifyTeamLoginDetailed,
  verifyTeamLogin,
  discoverAppsWithSyncthing,
  getAppsWithSyncthing,
  isAppExpiredInGlobalSpecs,
  getSecondaryNodeSelection,
  getSecondaryNodeFromHAProxy,
  getPrimaryNodeAddress,
  createBackupTaskOnNode,
  createBackupTaskWithTeamCredentials,
  isExplicitAuthorizationFailure,
  testHooks: {
    listVolumeFolder,
    ensureVolumeFolder,
    removeVolumeObject,
    compressOnNode,
    createProfiledArchiveOnNode,
    ensureProfileMarker,
    getPrimaryNodeAddress,
  },
};
