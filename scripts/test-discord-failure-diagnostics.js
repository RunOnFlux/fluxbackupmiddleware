const assert = require('assert');
const {
  formatDiagnostic,
  formatFailureAttempts,
} = require('../src/services/discordNotifier');

const diagnostic = formatDiagnostic({
  check: 'Flux node login phrase',
  outcome: 'failed',
  endpoint: 'http://89.58.51.211:16127/id/loginphrase',
  node: 'http://89.58.51.211:16127',
  errorCode: 'ETIMEDOUT',
  detail: 'connect ETIMEDOUT 89.58.51.211:16127',
});

assert(diagnostic.includes('Flux node login phrase'));
assert(diagnostic.includes('node=http://89.58.51.211:16127'));
assert(diagnostic.includes('code=ETIMEDOUT'));
assert(diagnostic.includes('/id/loginphrase'));

const grouped = formatFailureAttempts([1, 2, 3].map((attempt) => ({
  attempt,
  stage: 'node_selection',
  reason: 'Only the primary IP was available',
  diagnostics: [{
    check: 'Flux location API',
    outcome: 'failed',
    endpoint: 'https://api.runonflux.io/apps/location/example',
    node: '162.192.236.146',
    detail: 'Only the primary IP was available (1 location record)',
  }],
})));

assert(grouped.includes('Attempts 1, 2, 3'));
assert(grouped.includes('Final attempt checks'));
assert.strictEqual((grouped.match(/Attempts 1, 2, 3/g) || []).length, 1);

const redacted = formatDiagnostic({
  check: 'Safety test',
  outcome: 'failed',
  detail: 'loginPhrase=secret&signature=private&zelidauth=token',
});
assert(!redacted.includes('secret'));
assert(!redacted.includes('private'));
assert(!redacted.includes('token'));
assert(redacted.includes('[redacted]'));

console.log('Discord failure diagnostic tests passed');
