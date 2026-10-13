const assert = require('assert');
const axios = require('axios');
const log = require('../src/lib/log');
const fluxOS = require('../src/services/fluxOsService');
const Vault = require('../src/services/Vault');

const originalAxiosGet = axios.get;
const originalLogError = log.error;
const originalLogWarn = log.warn;
const originalGetKey = Vault.getKey;

async function main() {
  log.error = () => {};
  log.warn = () => {};
  axios.get = async () => ({
    status: 200,
    data: {
      status: 'error',
      data: {
        message: 'Flux communication is limited, other nodes cannot reach yours',
      },
    },
  });
  const rejected = await fluxOS.getLoginPhraseDetailed('http://23.226.161.131:16147');
  assert.strictEqual(rejected.phrase, null);
  assert(rejected.reason.includes('unavailable for backup authentication'));
  assert(rejected.reason.includes('error response'));
  assert(!rejected.reason.includes('Flux communication is limited'));
  assert.strictEqual(rejected.diagnostic.httpStatus, 200);
  assert.strictEqual(
    rejected.diagnostic.detail,
    'Node API responded but did not provide a login phrase',
  );

  axios.get = async () => {
    const error = new Error('connect ETIMEDOUT 23.226.161.131:16147');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  const unreachable = await fluxOS.getLoginPhraseDetailed('http://23.226.161.131:16147');
  assert.strictEqual(unreachable.phrase, null);
  assert(unreachable.reason.includes('Selected Flux node API is unreachable'));
  assert(unreachable.reason.includes('ETIMEDOUT'));
  assert.strictEqual(unreachable.diagnostic.errorCode, 'ETIMEDOUT');

  const secrets = {
    teamFluxID: 'primary-id',
    teamPK: 'primary-key',
    teamFluxID2: 'secondary-id',
    teamPK2: 'secondary-key',
  };
  Vault.getKey = async (key) => secrets[key] || null;
  const attempts = [];
  const fallback = await fluxOS.verifyTeamLoginDetailed(
    'http://192.0.2.10:16127',
    async (zelid) => {
      attempts.push(zelid);
      if (zelid === 'primary-id') {
        return {
          zelidAuth: null,
          reason: 'signature rejected',
          diagnostics: [
            { check: 'Flux node login phrase', outcome: 'success' },
            { check: 'Flux node login verification', outcome: 'failed' },
          ],
        };
      }
      return {
        zelidAuth: 'secondary-auth-token',
        reason: null,
        diagnostics: [
          { check: 'Flux node login phrase', outcome: 'success' },
          { check: 'Flux node login verification', outcome: 'success' },
        ],
      };
    },
  );
  assert.deepStrictEqual(attempts, ['primary-id', 'secondary-id']);
  assert.strictEqual(fallback.zelidAuth, 'secondary-auth-token');
  assert.strictEqual(fallback.credential, 'secondary');
  assert(fallback.diagnostics.some((item) => item.credential === 'primary'));
  assert(fallback.diagnostics.some((item) => item.credential === 'secondary'));

  attempts.length = 0;
  const nodeUnavailable = await fluxOS.verifyTeamLoginDetailed(
    'http://192.0.2.10:16127',
    async (zelid) => {
      attempts.push(zelid);
      return {
        zelidAuth: null,
        reason: 'connect ETIMEDOUT',
        diagnostics: [{ check: 'Flux node login phrase', outcome: 'failed' }],
      };
    },
  );
  assert.strictEqual(nodeUnavailable.zelidAuth, null);
  assert.deepStrictEqual(attempts, ['primary-id']);

  assert.strictEqual(await fluxOS.isTeamFluxId('primary-id'), true);
  assert.strictEqual(await fluxOS.isTeamFluxId('secondary-id'), true);
  assert.strictEqual(await fluxOS.isTeamFluxId('someone-else'), false);

  const creationLogins = [];
  const creationAttempts = [];
  const fallbackCreation = await fluxOS.createBackupTaskWithTeamCredentials(
    'http://192.0.2.10:16127',
    'marketplace-app',
    ['component'],
    async (zelid) => {
      creationLogins.push(zelid);
      return {
        zelidAuth: `${zelid}-auth`,
        diagnostics: [
          { check: 'Flux node login phrase', outcome: 'success' },
          { check: 'Flux node login verification', outcome: 'success' },
        ],
      };
    },
    async (node, zelidAuth) => {
      creationAttempts.push(zelidAuth);
      if (zelidAuth === 'primary-id-auth') {
        return {
          status: 'failed',
          components: [],
          error: 'Unauthorized. Access denied.',
          diagnostics: [{
            check: 'Flux node backup creation',
            outcome: 'failed',
            httpStatus: 200,
            detail: 'Unauthorized. Access denied.',
          }],
        };
      }
      return {
        status: 'completed',
        components: [{ component: 'component', backups: { name: 'backup.tar.gz' } }],
        diagnostics: [{ check: 'Flux node backup creation', outcome: 'success' }],
      };
    },
  );
  assert.deepStrictEqual(creationLogins, ['primary-id', 'secondary-id']);
  assert.deepStrictEqual(creationAttempts, ['primary-id-auth', 'secondary-id-auth']);
  assert.strictEqual(fallbackCreation.status, 'completed');
  assert.strictEqual(fallbackCreation.credential, 'secondary');
  assert(fallbackCreation.diagnostics.some((item) => item.credential === 'primary'));
  assert(fallbackCreation.diagnostics.some((item) => item.credential === 'secondary'));

  creationLogins.length = 0;
  creationAttempts.length = 0;
  const ambiguousCreationFailure = await fluxOS.createBackupTaskWithTeamCredentials(
    'http://192.0.2.10:16127',
    'marketplace-app',
    ['component'],
    async (zelid) => {
      creationLogins.push(zelid);
      return {
        zelidAuth: `${zelid}-auth`,
        diagnostics: [{ check: 'Flux node login phrase', outcome: 'success' }],
      };
    },
    async (node, zelidAuth) => {
      creationAttempts.push(zelidAuth);
      return {
        status: 'failed',
        components: [],
        error: 'connect ETIMEDOUT',
        diagnostics: [{
          check: 'Flux node backup creation',
          outcome: 'failed',
          errorCode: 'ETIMEDOUT',
          detail: 'connect ETIMEDOUT',
        }],
      };
    },
  );
  assert.deepStrictEqual(creationLogins, ['primary-id']);
  assert.deepStrictEqual(creationAttempts, ['primary-id-auth']);
  assert.strictEqual(ambiguousCreationFailure.status, 'failed');
  assert.strictEqual(ambiguousCreationFailure.failureStage, 'create_backup');

  console.log('Flux node authentication diagnostic tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    axios.get = originalAxiosGet;
    log.error = originalLogError;
    log.warn = originalLogWarn;
    Vault.getKey = originalGetKey;
  });
