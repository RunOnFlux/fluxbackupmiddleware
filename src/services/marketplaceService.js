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
    .filter((app) => app?.redirectUrl && Array.isArray(app.compose))
    .map((app) => ({
      repotags: app.compose.map((component) => component?.repotag || ''),
    }));
}

function matchesMarketplaceRepotags(repotags, marketplaceTemplates) {
  if (!Array.isArray(repotags) || repotags.length === 0) return false;
  if (!Array.isArray(marketplaceTemplates)) return false;

  return marketplaceTemplates.some((template) => (
    template.repotags.length === repotags.length
    && template.repotags.every((repotag, index) => repotag === repotags[index])
  ));
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
      throw new Error('Marketplace catalog contained no templates with redirectUrl');
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
  getMarketplaceTemplates,
  resetMarketplaceCache,
};
