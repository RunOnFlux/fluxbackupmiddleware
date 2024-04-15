/* eslint-disable no-param-reassign */
const axios = require('axios');
const appOwners = require('memory-cache');
const log = require('../lib/log');

const sessionExpireTime = 1 * 60 * 60 * 1000;
/**
 * Retrieves FluxOS app specifications for given appname.
 *
 * @async
 * @returns {Promise<Object|null>} - A promise that resolves to the status data if the request is successful, or null if the request fails.
 */
async function getAppSpecs(appname) {
  if (!appname) return false;
  try {
    const result = await axios({
      method: 'get',
      url: `https://api.runonflux.io/apps/appspecifications/${appname}`,
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
      value = appSpecs.owner;
      appOwners.put(appname, value, sessionExpireTime);
    }
  }
  if (value && value === owner) return true;
  return false;
}

module.exports = {
  getAppSpecs,
  verifyAppOwner,
};
