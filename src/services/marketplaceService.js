const axios = require('axios');
const config = require('../../config/default');
const log = require('../lib/log');

let marketplaceTemplatesCache = null;
let marketplaceCacheTimestamp = 0;

function extractMarketplaceTemplates(response) {
  let apps = null;
  if (Array.isArray(response)) {
    apps = response;
  } else if (Array.isArray(response?.data)) {
    apps = response.data;
  }

  if (!apps) return null;

  return apps
    // The marketplace API returns templates. Some valid enabled templates
    // (including Terraria) do not define redirectUrl, so it cannot be used as
    // a marketplace discriminator.
    .filter((app) => app?.enabled !== false
      && Array.isArray(app.compose)
      && app.compose.length > 0)
    .map((app) => ({
      repotags: app.compose.map((component) => component?.repotag || ''),
    }))
    .filter((template) => template.repotags.every(Boolean));
}

function matchesMarketplaceRepotags(repotags, marketplaceTemplates) {
  if (!Array.isArray(repotags) || repotags.length === 0) return false;
  if (!Array.isArray(marketplaceTemplates)) return false;

  return marketplaceTemplates.some((template) => (
    template.repotags.length === repotags.length
    && template.repotags.every((repotag, index) => repotag === repotags[index])
  ));
}

function getMarketplaceClassificationUpdate(currentValue, matchesMarketplace) {
  const nextValue = Number(Boolean(matchesMarketplace));
  if (currentValue === null || currentValue === undefined) return nextValue;
  // A refreshed catalog may recognize a template that an older classifier
  // missed. Promote false to true, but never automatically demote an app that
  // was already confirmed as marketplace.
  if (Number(currentValue) !== 1 && nextValue === 1) return 1;
  return null;
}

async function getMarketplaceTemplates(forceRefresh = false) {
  const now = Date.now();
  const cacheTtl = config.marketplaceCatalog.cacheHours * 60 * 60 * 1000;
  if (!forceRefresh && marketplaceTemplatesCache
    && now - marketplaceCacheTimestamp < cacheTtl) {
    return marketplaceTemplatesCache;
  }

  try {
    const response = await axios.get(config.marketplaceCatalog.url, { timeout: 30000 });
    const templates = extractMarketplaceTemplates(response.data);
    if (!templates || templates.length === 0) {
      throw new Error('Marketplace catalog contained no valid compose templates');
    }
    marketplaceTemplatesCache = templates;
    marketplaceCacheTimestamp = now;
    log.info(`Cached ${templates.length} Marketplace template signatures`);
    return marketplaceTemplatesCache;
  } catch (error) {
    log.error(`Failed to refresh Marketplace catalog: ${error.message}`);
    return marketplaceTemplatesCache;
  }
}

function resetMarketplaceCache() {
  marketplaceTemplatesCache = null;
  marketplaceCacheTimestamp = 0;
}

module.exports = {
  extractMarketplaceTemplates,
  matchesMarketplaceRepotags,
  getMarketplaceClassificationUpdate,
  getMarketplaceTemplates,
  resetMarketplaceCache,
};
