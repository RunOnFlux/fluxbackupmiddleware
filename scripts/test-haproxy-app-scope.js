const assert = require('assert');
const { parseSecondaryNodeFromHAProxyStats: parse } = require('../src/services/fluxOsService');

const header = '# pxname,svname,status,bck,act\n';
const backend = 'victim_30000apprunonfluxiobackend';
const row = (name, ip, bck = 1, status = 'UP') => `${name},${ip},${status},${bck},${bck ? 0 : 1}\n`;
const rogue = '203.0.113.200:16127';
const good = '198.51.100.2:16137';
const first = '198.51.100.1:16127';
const attack = row('evilvictim_30000apprunonfluxiobackend', rogue)
  + row('victim_evil_30000apprunonfluxiobackend', rogue)
  + row('victim_30000apprunonfluxiobackend_evil', rogue)
  + row('victim_30000attackercombackend', rogue);
assert.strictEqual(parse(header + attack, 'victim'), null);
assert.strictEqual(parse(header + attack + row(backend, good), 'victim'), good);
assert.strictEqual(parse(header + row(backend.toUpperCase(), good), 'ViCtIm'), good);
assert.strictEqual(parse(header + row(backend, rogue, 1, 'DOWN') + row(backend, first, 0) + row(backend, good, 0), 'victim'), good);
assert.strictEqual(parse(header + row(backend, first, 0) + row('victim_30001apprunonfluxiobackend', good, 0), 'victim'), null, 'Do not combine separate backend primaries into a secondary');
assert.strictEqual(parse(header + row(backend, first, 0) + row(backend, first, 0), 'victim'), null);
assert.strictEqual(parse(header + row(backend, '999.0.0.1:16127') + row(backend, '198.51.100.1:0'), 'victim'), null);
assert.strictEqual(parse('<tr class="backup_up"><td>203.0.113.200:16127</td></tr>', 'victim'), null);
assert.strictEqual(parse(header + row(backend, rogue), 'victim.*'), null);
assert.strictEqual(parse(`${header}\n`, 'victim'), null);
assert.strictEqual(parse(`# pxname,svname,status\n${row(backend, rogue)}`, 'victim'), null);
console.log('HAProxy exact app backend scope tests passed');
