function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function normalizeCacheRows(rows) {
  return new Map((rows || []).map((row) => [row.appname, {
    appname: row.appname,
    specHash: row.spec_hash,
    hasSyncthing: Boolean(row.has_syncthing),
    componentNames: parseJsonArray(row.components),
    repotags: parseJsonArray(row.repotags),
  }]));
}

function buildCacheUpdate(spec, entry) {
  if (!spec?.name || !spec.hash) return null;
  return {
    appname: spec.name,
    specHash: spec.hash,
    hasSyncthing: Boolean(entry),
    componentNames: entry?.componentNames || [],
    repotags: entry?.repotags || [],
  };
}

function getReusableDiscovery(spec, cacheByName, knownAppsByName) {
  if (!spec?.name || !spec.hash) return null;

  const cached = cacheByName.get(spec.name);
  if (cached?.specHash === spec.hash) {
    return {
      source: 'cache',
      entry: cached.hasSyncthing ? {
        appName: spec.name,
        componentNames: cached.componentNames,
        repotags: cached.repotags,
      } : null,
      cacheUpdate: null,
    };
  }

  const knownApp = knownAppsByName.get(spec.name);
  if (!cached && knownApp && knownApp.is_marketplace !== null) {
    const entry = {
      appName: spec.name,
      componentNames: parseJsonArray(knownApp.components),
      repotags: [],
    };
    return {
      source: 'bootstrap',
      entry,
      cacheUpdate: buildCacheUpdate(spec, entry),
    };
  }

  return null;
}

module.exports = {
  parseJsonArray,
  normalizeCacheRows,
  buildCacheUpdate,
  getReusableDiscovery,
};
