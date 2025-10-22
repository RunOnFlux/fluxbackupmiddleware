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

// Create HTTPS agent that accepts insecure connections
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const sessionExpireTime = 1 * 60 * 60 * 1000;
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
async function getAppOwner(appname) {
  let value = appOwners.get(appname);
  if (!value) {
    const appSpecs = await getAppSpecs(appname);
    if (appSpecs) {
      value = { owner: appSpecs.owner, expireHeight: appSpecs.expire + appSpecs.height };
      appOwners.put(appname, value, sessionExpireTime);
    }
  }
  if (value) return value.owner;
  return false;
}

/**
 * Gets the first secondary/backup node IP:port from HAProxy statistics for a given app.
 *
 * @async
 * @param {string} appname - The name of the application
 * @returns {Promise<string|null>} - The IP:port of the first secondary node, or null if not found
 */
async function getSecondaryNodeFromHAProxy(appname) {
  try {
    // Add underscore to scope to ensure exact appname matching (e.g., "rc_" instead of "rc")
    // This prevents matching apps like "search" when looking for "rc"
    const statsUrl = `https://${appname}.app.runonflux.io/fluxstatistics?scope=${appname}_`;
    const response = await axios.get(statsUrl, { httpsAgent });

    if (!response.data) {
      log.error('No data received from HAProxy statistics');
      return null;
    }

    const htmlContent = response.data;

    // Parse the HTML to find backend servers
    // Look for rows with backend servers and their status
    const serverRowRegex = /<tr class="(?:active_up|backup_up|active_down|backup_down)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;

    let secondaryNode = null;
    const activeNodes = [];
    let match = serverRowRegex.exec(htmlContent);

    // Find server rows and extract IP:port
    while (match !== null) {
      const rowContent = match[1];
      const ipMatch = rowContent.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+)/);

      if (ipMatch) {
        // Check if this is a backup/secondary server
        if (match[0].includes('backup_up')) {
          [secondaryNode] = ipMatch;
          break; // Found the first backup node
        }
        // Collect active nodes as fallback
        if (match[0].includes('active_up')) {
          activeNodes.push(ipMatch[0]);
        }
      }
      match = serverRowRegex.exec(htmlContent);
    }

    // Alternative parsing if the above doesn't work
    if (!secondaryNode) {
      // Look for backup servers in the backend section
      const tableRegex = /<table[^>]*>[\s\S]*?<\/table>/gi;
      const tables = htmlContent.match(tableRegex);

      if (tables) {
        tables.forEach((table) => {
          if (!secondaryNode) {
            // Look for backend servers table
            if (table.includes(appname) && table.includes('Backend')) {
              // Find rows with backup servers that are UP
              const backupServerRegex = /<tr[^>]*class="[^"]*backup[^"]*"[^>]*>[\s\S]*?<td[^>]*>(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+)[^<]*<\/td>[\s\S]*?<td[^>]*>UP<\/td>/gi;
              const backupMatch = backupServerRegex.exec(table);
              if (backupMatch) {
                [, secondaryNode] = backupMatch;
              }
            }
          }
        });
      }
    }

    // If no backup node found but we have active nodes, use the second active node (or first if only one)
    if (!secondaryNode && activeNodes.length > 0) {
      // Prefer the second node if available, otherwise use the first
      secondaryNode = activeNodes[Math.min(1, activeNodes.length - 1)];
      log.info(`No backup nodes found for ${appname}, using active node: ${secondaryNode}`);
      return secondaryNode;
    }

    if (secondaryNode) {
      log.info(`Secondary/backup node for ${appname}: ${secondaryNode}`);
      return secondaryNode;
    }

    log.warn(`No nodes found for ${appname}`);
    return null;
  } catch (error) {
    log.error(`Failed to get HAProxy statistics for ${appname}`, { error: error.message });
    return null;
  }
}

async function getLoginPhrase(node) {
  try {
    const api = `${node}/id/loginphrase`;
    const response = await axios.get(api, { httpsAgent });
    if (response.data.status === 'error') {
      throw new Error(response.data.data);
    }
    return response.data.data;
  } catch (error) {
    log.error(`Failed to get login phrase from Flux API: ${error.message}`, { stack: error.stack });
    return null;
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

async function verifyLogin(zelid, privateKeySign, node) {
  try {
    const loginPhrase = await getLoginPhrase(node);
    if (!loginPhrase) {
      log.error('Failed to get login phrase');
      return false;
    }

    const signature = signMessage(loginPhrase, privateKeySign);
    const loginInfo = {
      zelid,
      signature,
      loginPhrase,
    };

    const response = await axios.post(`${node}/id/verifylogin`, qs.stringify(loginInfo), { httpsAgent });

    if (response.data.status === 'success') {
      const zelidAuth = qs.stringify(loginInfo);
      log.info('Authentication successful');
      return zelidAuth;
    }

    log.warn(`Login verification failed: ${response.data.message || 'Unknown error'}`);
    return false;
  } catch (error) {
    log.error(`Error in verifyLogin: ${error.message}`, { stack: error.stack });
    return false;
  }
}

/**
 * Retrieves all global app specifications and filters for apps with Syncthing components.
 * Syncthing components are identified by containerData starting with 's:', 'r:', or 'g:'.
 *
 * @async
 * @returns {Promise<Array|false>} - A promise that resolves to an array of apps with Syncthing components,
 * or false if the request fails. Each app object contains appName and componentNames.
 */
async function getAppsWithSyncthing() {
  try {
    const result = await axios({
      method: 'get',
      url: 'https://api.runonflux.io/apps/globalappsspecifications',
      httpsAgent,
    });

    if (result.data && result.data.status && result.data.status === 'success') {
      const allApps = result.data.data;
      const appsWithSyncthing = [];

      allApps.forEach((app) => {
        let hasSyncthingComponent = false;
        const allComponentNames = [];

        // Check if the app has compose (multi-component) structure
        if (app.compose && Array.isArray(app.compose)) {
          app.compose.forEach((component) => {
            const componentName = component.name || 'unnamed-component';
            allComponentNames.push(componentName);

            if (component.containerData
                && (component.containerData.startsWith('s:')
                || component.containerData.startsWith('r:')
                || component.containerData.startsWith('g:'))) {
              hasSyncthingComponent = true;
            }
          });
        } else if (app.containerData
                 && (app.containerData.startsWith('s:')
                 || app.containerData.startsWith('r:')
                 || app.containerData.startsWith('g:'))) {
          // Check single component apps
          hasSyncthingComponent = true;
          allComponentNames.push('main');
        }

        // If we found at least one Syncthing component, add all components to results
        if (hasSyncthingComponent && (true || app.name.startsWith('wordpress'))) {
          appsWithSyncthing.push({
            appName: app.name,
            componentNames: allComponentNames,
          });
        }
      });

      return appsWithSyncthing;
    }
    return false;
  } catch (e) {
    log.error('Failed to fetch global app specifications', e);
    return false;
  }
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
      url: `${node}/apps/appendbackuptask`,
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

    log.info(`Backup task created successfully for ${appname}`);

    // Wait longer for backup creation to ensure files are generated
    log.info(`Waiting for backup files to be created for ${appname}...`);
    await new Promise((resolve) => { setTimeout(resolve, 5 * 60 * 1000); }); // Wait 5 minutes

    // Get volume mount paths for all components upfront
    const componentMounts = {};
    for (let i = 0; i < componentList.length; i += 1) {
      const component = componentList[i];
      try {
        const volumeResponse = await axios({
          method: 'get',
          url: `${node}/backup/getvolumedataofcomponent/${appname}/${component}/B/0/mount`,
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
          log.error(`Failed to get mount path for component ${component}`);
        }
      } catch (error) {
        log.error(`Error fetching volume data for component ${component}: ${error.message}`);
      }
    }

    // Verify backup creation completed by checking task status
    let backupReady = false;
    let statusCheckCount = 0;
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
          statusCheckCount += 1;
          if (statusCheckCount < maxStatusChecks) {
            log.info(`Waiting for backup creation to complete (check ${statusCheckCount}/${maxStatusChecks})...`);
            await new Promise((resolve) => { setTimeout(resolve, 5000); });
          }
        }
      } catch (error) {
        statusCheckCount += 1;
        if (statusCheckCount < maxStatusChecks) {
          log.info(`Backup not ready yet (check ${statusCheckCount}/${maxStatusChecks}): ${error.message}`);
          await new Promise((resolve) => { setTimeout(resolve, 5000); });
        }
      }
    }

    if (!backupReady) {
      log.warn(`Backup creation may not have completed for ${appname} after ${maxStatusChecks} checks, proceeding anyway`);
    }

    // Get backup lists for each component
    const backupResults = [];
    const maxRetries = 10;

    for (let i = 0; i < componentList.length; i += 1) {
      const component = componentList[i];
      let componentBackupData = null;
      let retryCount = 0;

      while (retryCount < maxRetries && !componentBackupData) {
        try {
          // Use the cached mount path for this component
          const mount = componentMounts[component];
          if (!mount) {
            throw new Error(`No mount path available for component ${component}`);
          }

          const backupPath = encodeURIComponent(`${mount}/backup/local`);
          const backupListUrl = `${node}/backup/getlocalbackuplist/${backupPath}/B/0/true/${appname}`;

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
            // Filter backup files for this specific component and get the latest one
            const allBackups = backupListResponse.data.data.filter((backup) => backup.name.includes(`backup_${component}.tar.gz`));

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
            }
          } else {
            log.info(`No backup data found for component ${component}, attempt ${retryCount + 1}`);
            log.info(backupListResponse.data.data);
          }
        } catch (error) {
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
        log.error(`Failed to get backup data for component ${component} after ${maxRetries} attempts`);
        backupResults.push({
          component,
          backups: [],
          error: `Failed to retrieve backup after ${maxRetries} attempts`,
        });
      }
    }

    const result = {
      appname,
      status: 'completed',
      components: backupResults,
      totalComponents: componentList.length,
      successfulComponents: backupResults.filter((r) => r.backups && r.backups.length > 0).length,
    };

    log.info(`Backup task completed for ${appname}. ${result.successfulComponents}/${result.totalComponents} components successful`);
    return result;
  } catch (error) {
    log.error(`Error creating backup task for ${appname}: ${error.message}`, { stack: error.stack });
    return null;
  }
}

module.exports = {
  getAppSpecs,
  getBlockHeight,
  verifyAppOwner,
  getAppOwner,
  getAppExpireHeight,
  verifyLogin,
  getAppsWithSyncthing,
  getSecondaryNodeFromHAProxy,
  createBackupTaskOnNode,
};
