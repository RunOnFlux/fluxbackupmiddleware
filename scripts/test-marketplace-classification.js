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
      name: 'Terraria',
      enabled: true,
      compose: [{ repotag: 'ryshe/terraria:tshock-latest' }],
    },
    {
      name: 'Disabled template',
      enabled: false,
      compose: [{ repotag: 'repo/disabled:1' }],
    },
    {
      name: 'Missing image tag',
      compose: [{ name: 'component-without-repotag' }],
    },
  ],
});

assert.deepStrictEqual(templates, [
  { repotags: ['repo/a:1', 'repo/b:2'] },
  { repotags: ['ryshe/terraria:tshock-latest'] },
]);
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
assert.strictEqual(
  marketplaceService.matchesMarketplaceRepotags(
    ['ryshe/terraria:tshock-latest'],
    templates,
  ),
  true,
);
assert.strictEqual(marketplaceService.getMarketplaceClassificationUpdate(null, false), 0);
assert.strictEqual(marketplaceService.getMarketplaceClassificationUpdate(0, true), 1);
assert.strictEqual(marketplaceService.getMarketplaceClassificationUpdate(1, false), null);
assert.strictEqual(marketplaceService.getMarketplaceClassificationUpdate(0, false), null);
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
