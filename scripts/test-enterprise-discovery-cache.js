const assert = require('assert');
const {
  normalizeCacheRows,
  buildCacheUpdate,
  getReusableDiscovery,
} = require('../src/services/utils/enterpriseDiscoveryCache');

const appSpec = { name: 'enterprise-app', hash: 'hash-v1' };
const cache = normalizeCacheRows([{
  appname: appSpec.name,
  spec_hash: appSpec.hash,
  has_syncthing: 1,
  components: '["database","web"]',
  repotags: '["mysql:8","wordpress:latest"]',
}]);

const cached = getReusableDiscovery(appSpec, cache, new Map());
assert.strictEqual(cached.source, 'cache');
assert.deepStrictEqual(cached.entry.componentNames, ['database', 'web']);
assert.deepStrictEqual(cached.entry.repotags, ['mysql:8', 'wordpress:latest']);

const negativeCache = normalizeCacheRows([{
  appname: appSpec.name,
  spec_hash: appSpec.hash,
  has_syncthing: 0,
  components: [],
  repotags: [],
}]);
assert.strictEqual(getReusableDiscovery(appSpec, negativeCache, new Map()).entry, null);

const changedSpec = { ...appSpec, hash: 'hash-v2' };
assert.strictEqual(getReusableDiscovery(changedSpec, cache, new Map()), null);

const knownApps = new Map([[appSpec.name, {
  appname: appSpec.name,
  components: '["database"]',
  is_marketplace: 1,
}]]);
const bootstrapped = getReusableDiscovery(appSpec, new Map(), knownApps);
assert.strictEqual(bootstrapped.source, 'bootstrap');
assert.deepStrictEqual(bootstrapped.entry.componentNames, ['database']);
assert.strictEqual(bootstrapped.cacheUpdate.specHash, appSpec.hash);

const unclassifiedApps = new Map([[appSpec.name, {
  appname: appSpec.name,
  components: '["database"]',
  is_marketplace: null,
}]]);
assert.strictEqual(getReusableDiscovery(appSpec, new Map(), unclassifiedApps), null);

const positiveUpdate = buildCacheUpdate(appSpec, {
  appName: appSpec.name,
  componentNames: ['web'],
  repotags: ['wordpress:latest'],
});
assert.strictEqual(positiveUpdate.hasSyncthing, true);
assert.deepStrictEqual(positiveUpdate.componentNames, ['web']);

const negativeUpdate = buildCacheUpdate(appSpec, null);
assert.strictEqual(negativeUpdate.hasSyncthing, false);
assert.deepStrictEqual(negativeUpdate.componentNames, []);
assert.strictEqual(buildCacheUpdate({ name: appSpec.name }, null), null);

console.log('enterprise discovery cache tests passed');
