const assert = require('assert');

// fluxOsService calls axios(config) directly, so the mock replaces the module
// itself before anything requires it.
const calls = [];
let routes = [];
async function axiosMock(request) {
  calls.push(request);
  const route = routes.find((candidate) => candidate.match(request));
  if (!route) throw new Error(`Unexpected request in test: ${request.method} ${request.url}`);
  return route.reply(request);
}
axiosMock.get = async (url, options) => axiosMock({ method: 'get', url, ...options });
axiosMock.post = async (url, data, options) => axiosMock({
  method: 'post', url, data, ...options,
});
require.cache[require.resolve('axios')] = {
  id: require.resolve('axios'), filename: require.resolve('axios'), loaded: true, exports: axiosMock,
};

// Vault reads the gitignored secrets.json, which a checkout without credentials
// does not have; nothing here signs anything.
const Module = require('module');
const path = require('path');

const fakeSecrets = path.resolve(__dirname, '../secrets.test-stub.json');
// eslint-disable-next-line no-underscore-dangle
const originalResolve = Module._resolveFilename;
// eslint-disable-next-line no-underscore-dangle
Module._resolveFilename = function resolveWithSecretsStub(request, parent, ...rest) {
  if (request === '../../secrets') return fakeSecrets;
  return originalResolve.call(this, request, parent, ...rest);
};
require.cache[fakeSecrets] = {
  id: fakeSecrets, filename: fakeSecrets, loaded: true, exports: {},
};

const log = require('../src/lib/log');
const backupProfiles = require('../src/services/utils/backupProfiles');
const fluxOS = require('../src/services/fluxOsService');
const { testHooks: backupHooks } = require('../src/services/backupService');

const NODE = 'http://10.0.0.2:16127';
const APP = 'dragonwilds1790000000000';
const COMPONENT = 'dragonwilds';
const IMAGE = 'indifferentbroccoli/runescape-dragonwilds-server-docker:latest';
const profile = backupProfiles.profileForRepotag(IMAGE);
const success = (data) => ({ status: 200, headers: {}, data: { status: 'success', data } });
const missing = () => ({
  status: 200,
  headers: {},
  data: { status: 'error', data: { code: 'ENOENT', message: "ENOENT: no such file or directory, realpath '/x'" } },
});
const folderRoute = (folder, reply) => ({
  match: (r) => r.method === 'get' && r.url === `${NODE}/apps/getfolderinfo/${APP}/${COMPONENT}/${encodeURIComponent(folder)}`,
  reply,
});
const anyCreateFolder = {
  match: (r) => r.url.startsWith(`${NODE}/apps/createfolder/`),
  reply: () => ({ status: 200, headers: {}, data: { status: 'error', data: { code: 'EEXIST', message: 'already exists' } } }),
};

// The layout of a real Dragonwilds volume (backup taken 2026-09-17).
const worldFolders = (saveGames = [{ name: 'Vanhiem.sav', isFile: true, size: 122727 }]) => [
  folderRoute('appdata/RSDragonwilds/Saved/SaveGames', () => success(saveGames)),
  folderRoute('appdata/RSDragonwilds/Saved/Config', () => success([{ name: 'LinuxServer', isDirectory: true, size: 9912 }])),
  folderRoute('appdata/RSDragonwilds/Content/Paks/~mods', missing),
];

function compressRoute(jobStatuses, statusUrl) {
  let polls = 0;
  return [
    {
      match: (r) => r.method === 'post' && r.url === `${NODE}/apps/compressobject`,
      reply: () => ({ status: 202, headers: {}, data: { status: 'success', data: { jobId: 'job-1', statusUrl } } }),
    },
    {
      match: (r) => r.method === 'get' && r.url === `${NODE}/apps/operations/job-1`,
      reply: () => {
        const status = jobStatuses[Math.min(polls, jobStatuses.length - 1)];
        polls += 1;
        return {
          status: 200,
          headers: {},
          data: { status: 'success', data: { status, ...(status === 'Failed' ? { error: { detail: 'tar: disk full' } } : {}) } },
        };
      },
    },
  ];
}

async function main() {
  log.info = () => {};
  log.warn = () => {};
  log.error = () => {};
  // Every wait in the node code is a setTimeout; none of them matters here.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => { fn(); return 0; };

  try {
    // --- matching ------------------------------------------------------------
    assert.strictEqual(backupProfiles.imageOf('Docker.io/Foo/Bar:1.2@sha256:abc'), 'foo/bar');
    assert.strictEqual(backupProfiles.imageOf('ghcr.io/acemod/arma-reforger:latest'), 'ghcr.io/acemod/arma-reforger');
    assert.strictEqual(backupProfiles.imageOf('localhost:5000/img'), 'localhost:5000/img');
    assert.strictEqual(profile.id, 'dragonwilds-world');
    assert.strictEqual(backupProfiles.profileForRepotag('indifferentbroccoli/runescape-dragonwilds-server-docker'), profile);
    assert.strictEqual(backupProfiles.profileForRepotag('lloesche/valheim-server:latest'), null);

    const resolved = backupProfiles.resolveComponentProfiles([COMPONENT], [COMPONENT], [IMAGE]);
    assert.deepStrictEqual(Object.keys(resolved), [COMPONENT]);
    assert.strictEqual(backupProfiles.resolveComponentProfiles([COMPONENT, 'db'], [COMPONENT, 'db'], [IMAGE, 'mysql:8']), null, 'all components need a profile');
    assert.strictEqual(backupProfiles.resolveComponentProfiles(['other'], [COMPONENT], [IMAGE]), null);
    assert.strictEqual(backupProfiles.resolveComponentProfiles([COMPONENT], null, null), null);

    // --- planning ------------------------------------------------------------
    const plan = backupProfiles.planProfiledArchive(profile, {
      'RSDragonwilds/Saved/SaveGames': [{ name: 'W.sav', isFile: true, size: 10 }],
      'RSDragonwilds/Saved/Config': [],
      'RSDragonwilds/Content/Paks/~mods': null,
    });
    assert.deepStrictEqual(plan, {
      fits: true,
      sources: ['appdata/.flux-backup', 'appdata/RSDragonwilds/Saved/SaveGames', 'appdata/RSDragonwilds/Saved/Config'],
    });
    assert.strictEqual(backupProfiles.planProfiledArchive(profile, { 'RSDragonwilds/Saved/SaveGames': null }).fits, false);
    assert.strictEqual(backupProfiles.planProfiledArchive(profile, {
      'RSDragonwilds/Saved/SaveGames': [{ name: 'W.sav', isFile: true, size: 0 }],
    }).fits, false, 'an empty .sav is no world');
    assert.strictEqual(backupProfiles.planProfiledArchive(profile, {
      'RSDragonwilds/Saved/SaveGames': [{ name: 'notes.txt', isFile: true, size: 9 }],
    }).fits, false);

    // --- the archive on the node ----------------------------------------------
    calls.length = 0;
    routes = [...worldFolders(), anyCreateFolder, ...compressRoute(['Running', 'Succeeded'], '/apps/operations/job-1')];
    let outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', APP, COMPONENT, profile, []);
    assert.deepStrictEqual(outcome, { fits: true });
    const compress = calls.find((r) => r.url.endsWith('/apps/compressobject'));
    assert.deepStrictEqual(compress.data, {
      appname: APP,
      component: COMPONENT,
      source: ['appdata/.flux-backup', 'appdata/RSDragonwilds/Saved/SaveGames', 'appdata/RSDragonwilds/Saved/Config'],
      destination: `backup/local/backup_${COMPONENT}.tar.gz`,
      overwrite: true,
    });
    const created = calls.filter((r) => r.url.includes('/apps/createfolder/')).map((r) => decodeURIComponent(r.url.split('/').pop()));
    assert.deepStrictEqual(created, ['appdata/.flux-backup', 'backup', 'backup/local']);

    // A copy with no world is not archived.
    calls.length = 0;
    routes = [...worldFolders([]), anyCreateFolder, ...compressRoute(['Succeeded'])];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', APP, COMPONENT, profile, []);
    assert.strictEqual(outcome.fits, false);
    assert(!calls.some((r) => r.url.endsWith('/apps/compressobject')));

    // A node that cannot list is a failure to retry elsewhere, never "missing".
    routes = [folderRoute('appdata/RSDragonwilds/Saved/SaveGames', () => ({ status: 200, headers: {}, data: { status: 'error', data: { message: 'Application volume not found' } } }))];
    await assert.rejects(
      fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', APP, COMPONENT, profile, []),
      /Could not list/,
    );

    // A failed job is an error even though every response was a 200.
    routes = [...worldFolders(), anyCreateFolder, ...compressRoute(['Running', 'Failed'])];
    await assert.rejects(
      fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', APP, COMPONENT, profile, []),
      /compressobject Failed: tar: disk full/,
    );

    // An offered statusUrl on another host is never followed.
    calls.length = 0;
    routes = [...worldFolders(), anyCreateFolder, ...compressRoute(['Succeeded'], 'https://evil.example/steal')];
    await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', APP, COMPONENT, profile, []);
    assert(!calls.some((r) => r.url.includes('evil.example')));

    // --- the whole node step ----------------------------------------------------
    const mount = `/var/lib/fluxos/flux-apps/flux${COMPONENT}_${APP}`;
    const listingRoutes = [
      {
        match: (r) => r.url === `${NODE}/backup/getvolumedataofcomponent/${APP}/${COMPONENT}/B/0/mount`,
        reply: () => success({ mount }),
      },
      {
        match: (r) => r.url.startsWith(`${NODE}/backup/getlocalbackuplist/`),
        reply: () => success([{ name: `backup_${COMPONENT}.tar.gz`, create: 1760000000000, size: 74125 }]),
      },
    ];

    calls.length = 0;
    routes = [...worldFolders(), anyCreateFolder, ...compressRoute(['Succeeded']), ...listingRoutes];
    let result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.components[0].profile, 'dragonwilds-world');
    assert.strictEqual(result.components[0].backups.size, 74125);
    assert(!calls.some((r) => r.url.endsWith('/apps/appendbackuptask')), 'a profiled backup never stops the app for a full archive');

    // Layout mismatch -> the full backup, exactly as before.
    calls.length = 0;
    routes = [
      ...worldFolders([]),
      {
        match: (r) => r.url === `${NODE}/apps/appendbackuptask`,
        reply: () => ({ status: 200, headers: {}, data: 'Finalizing...\n' }),
      },
      ...listingRoutes,
    ];
    result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.components[0].profile, null);
    const full = calls.find((r) => r.url.endsWith('/apps/appendbackuptask'));
    assert.deepStrictEqual(full.data, { appname: APP, backup: [{ component: COMPONENT, backup: true }] });
    assert(result.diagnostics.some((d) => d.outcome === 'skipped' && /dragonwilds-world does not fit/.test(d.detail)));

    // No profile -> unchanged behaviour.
    calls.length = 0;
    result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT]);
    assert.strictEqual(result.components[0].profile, null);
    assert(!calls.some((r) => r.url.includes('/apps/getfolderinfo/')));

    // The team-credentials wrapper hands the profiles on to the node call.
    Object.assign(require.cache[fakeSecrets].exports, { teamFluxID: 'team-id', teamPK: 'team-key' });
    const seen = [];
    await fluxOS.createBackupTaskWithTeamCredentials(
      NODE,
      APP,
      [COMPONENT],
      async () => ({ zelidAuth: 'auth', diagnostics: [] }),
      async (...args) => { seen.push(args); return { status: 'completed', components: [] }; },
      { [COMPONENT]: profile },
    );
    assert.strictEqual(seen[0][4][COMPONENT].id, 'dragonwilds-world');

    // --- backupService ----------------------------------------------------------
    backupHooks.setDatabaseForTests({
      async execute(sql, params) {
        if (sql.includes('FROM enterprise_app_discovery')) {
          return params[0] === APP ? [{ components: JSON.stringify([COMPONENT]), repotags: JSON.stringify([IMAGE]) }] : [];
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
    });
    const profiles = await backupHooks.resolveBackupProfiles(APP, [COMPONENT]);
    assert.strictEqual(profiles[COMPONENT].id, 'dragonwilds-world');

    routes = [{
      match: (r) => r.url.startsWith('https://api.runonflux.io/apps/appspecifications/'),
      reply: () => success({ name: 'other', version: 8, compose: [{ name: 'web', repotag: 'nginx:latest' }] }),
    }];
    assert.strictEqual(await backupHooks.resolveBackupProfiles('other', ['web']), null);

    assert.deepStrictEqual(backupHooks.checkpointComponent({
      component: COMPONENT, hash: 'Qm1', filesize: 74125, backup_profile: 'dragonwilds-world',
    }), {
      component: COMPONENT,
      file_url: 'https://jetpack2_38080.app.runonflux.io/ipfs/Qm1',
      file_size: 74125,
      profile: 'dragonwilds-world',
    });
    assert.strictEqual('profile' in backupHooks.checkpointComponent({ component: COMPONENT, hash: 'Qm2', filesize: 1 }), false);
  } finally {
    global.setTimeout = realSetTimeout;
  }

  console.log('backup profile tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
