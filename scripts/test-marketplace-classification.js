const assert = require('assert');
const marketplaceService = require('../src/services/marketplaceService');
const enterpriseCrypto = require('../src/services/enterpriseCrypto');

const templates = marketplaceService.extractMarketplaceTemplates({
  data: [
    {
      name: 'Template A',
      redirectUrl: 'https://example.com',
      compose: [{ repotag: 'repo/a:1' }, { repotag: 'repo/b:2' }],
    },
    {
      name: 'No redirect',
      compose: [{ repotag: 'repo/ignored:1' }],
    },
  ],
});

assert.deepStrictEqual(templates, [{ repotags: ['repo/a:1', 'repo/b:2'] }]);
assert.strictEqual(
  marketplaceService.matchesMarketplaceRepotags(['repo/a:1', 'repo/b:2'], templates),
  true,
);
assert.strictEqual(
  marketplaceService.matchesMarketplaceRepotags(['repo/b:2', 'repo/a:1'], templates),
  false,
);
assert.strictEqual(
  marketplaceService.matchesMarketplaceRepotags(['repo/a:1'], templates),
  false,
);
assert.strictEqual(marketplaceService.extractMarketplaceTemplates({ invalid: [] }), null);

const syncthingEntry = enterpriseCrypto.buildSyncthingAppEntry({
  name: 'deployed-app-name',
  compose: [
    { name: 'first', repotag: 'repo/a:1', containerData: 's:/data' },
    { name: 'second', repotag: 'repo/b:2', containerData: 'none' },
  ],
});
assert.deepStrictEqual(syncthingEntry, {
  appName: 'deployed-app-name',
  componentNames: ['first', 'second'],
  repotags: ['repo/a:1', 'repo/b:2'],
});

console.log('Marketplace classification tests passed');
