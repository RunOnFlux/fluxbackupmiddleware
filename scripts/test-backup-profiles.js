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
const profile = backupProfiles.profileForComponent({
  appname: APP, component: COMPONENT, repotag: IMAGE, componentCount: 1,
});
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
    // The games hub's rule: the game is named by the app, the component or the
    // image, and any one is enough.
    assert.strictEqual(profile.id, 'dragonwilds-world');
    const byComponent = (component, extra = {}) => backupProfiles.profileForComponent({
      appname: 'x1', component, repotag: null, componentCount: 1, ...extra,
    });
    assert.strictEqual(byComponent('dragonwilds'), profile, 'hub plan component');
    assert.strictEqual(byComponent('DragonwildsDragonwilds'), profile, 'marketplace component, any case');
    assert.strictEqual(byComponent('web', { repotag: 'runonflux/dragonwilds-server:2.0' }), profile, 'our own image would still match');
    assert.strictEqual(byComponent('web', { appname: 'dragonwilds1790000000000' }), profile, 'app name, single component');
    assert.strictEqual(byComponent('web', { appname: 'dragonwilds1790000000000', componentCount: 2 }), null, 'app name says nothing about which of several components');
    assert.strictEqual(byComponent('mydragonwilds'), null, 'component rule is anchored, as in the hub');
    assert.strictEqual(byComponent('palworld', { repotag: 'thijsvanloef/palworld-server-docker:latest', appname: 'palworld1' }), null);

    // No image needed: an enterprise spec read from the chain has none.
    const resolved = backupProfiles.resolveComponentProfiles(APP, [COMPONENT]);
    assert.deepStrictEqual(Object.keys(resolved), [COMPONENT]);
    assert.strictEqual(backupProfiles.resolveComponentProfiles(APP, [COMPONENT, 'db']), null, 'all components need a profile');
    assert.strictEqual(backupProfiles.resolveComponentProfiles('dragonwilds1', ['web'], { componentCount: 3 }), null);
    assert.strictEqual(backupProfiles.resolveComponentProfiles(APP, []), null);

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

    // A failed job is a failure even though every response was a 200, and it
    // sends the backup to the full archive rather than failing it.
    routes = [...worldFolders(), anyCreateFolder, ...compressRoute(['Running', 'Failed'])];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', APP, COMPONENT, profile, []);
    assert.deepStrictEqual(outcome, { fits: false, archiveFailed: true, reason: 'compressobject Failed: tar: disk full' });

    // A FluxOS older than 8.18 has no compressobject: the same.
    routes = [...worldFolders(), anyCreateFolder, {
      match: (r) => r.url === `${NODE}/apps/compressobject`,
      reply: () => ({ status: 404, headers: {}, data: 'Cannot POST /apps/compressobject' }),
    }];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', APP, COMPONENT, profile, []);
    assert.strictEqual(outcome.archiveFailed, true);
    assert(/older than 8\.18/.test(outcome.reason));

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

    // The node cannot write the partial archive -> the full backup, not no backup.
    calls.length = 0;
    routes = [
      ...worldFolders(),
      anyCreateFolder,
      {
        match: (r) => r.url === `${NODE}/apps/compressobject`,
        reply: () => ({ status: 404, headers: {}, data: 'Cannot POST /apps/compressobject' }),
      },
      {
        match: (r) => r.url === `${NODE}/apps/appendbackuptask`,
        reply: () => ({ status: 200, headers: {}, data: 'Finalizing...\n' }),
      },
      ...listingRoutes,
    ];
    result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.components[0].profile, null);
    assert(calls.some((r) => r.url.endsWith('/apps/appendbackuptask')));
    assert(result.diagnostics.some((d) => d.outcome === 'skipped' && /dragonwilds-world archive failed: .*older than 8\.18/.test(d.detail)));

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

    // --- Valheim -------------------------------------------------------------------
    const VAPP = 'valheim1790000000000';
    const VCOMP = 'valheimvalheim';
    const valheim = backupProfiles.profileForComponent({
      appname: VAPP, component: VCOMP, repotag: null, componentCount: 1,
    });
    assert.strictEqual(valheim.id, 'valheim-world', 'marketplace component');
    assert.strictEqual(byComponent('valheim').id, 'valheim-world', 'hub plan component');
    assert.strictEqual(byComponent('web', { repotag: 'lloesche/valheim-server:latest' }).id, 'valheim-world');
    assert.strictEqual(byComponent('dragonwildsdragonwilds'), profile, 'Dragonwilds still its own');

    const file = (name, size, minutesAgo = 60) => ({
      name, size, isFile: true, isDirectory: false, modifiedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    });
    const dir = (name, size, children) => ({
      name, size, isFile: false, isDirectory: true, ...(children ? { children } : {}),
    });
    // A committed 1.0 world (valheim1790392831101, generation 260), and the
    // half-synced one (valheim1789657999079: .ok and .fwl2 at 852, .db2 and
    // .chunks still at 851).
    const committed = [
      file('00_00__0_1.chunk', 183), file('1e_1e__1_46.chunk', 1142295),
      file('_main.260.chunks', 197), file('_main.260.db2', 149852), file('_main.260.fwl2', 1563), file('_main.260.ok', 4),
      file('_main.259.sync-conflict-20260930-165322-XUVBXFM.db2', 149852),
    ];
    const halfSynced = [
      file('_main.851.chunks', 681), file('_main.851.db2', 164003), file('_main.852.fwl2', 2998), file('_main.852.ok', 4),
    ];
    const worlds = valheim.include[0];
    assert.strictEqual(worlds.validate([dir('localhost', 7800000, committed)]), null);
    assert.match(worlds.validate([dir('Vally2026', 170000, halfSynced)]), /_main\.852\.ok but no _main\.852\.db2 \(a half-synced save\)/);
    assert.match(worlds.validate([dir('W', 10, [file('_main.1.db2', 9)])]), /no _main\.N\.ok/, 'a first save in progress');
    assert.strictEqual(worlds.validate([file('Old.db', 9000), file('Old.fwl', 40)]), null, 'a pre-1.0 world');
    assert.match(worlds.validate([file('Old.db', 9000)]), /Old\.db has no Old\.fwl/);
    assert.strictEqual(worlds.validate([]), 'no world');
    assert.strictEqual(worlds.validate([dir('empty', 0, [])]), 'no world');
    assert.strictEqual(worlds.validate([dir('localhost', 1, committed), dir('Vally2026', 1, halfSynced)]) !== null, true, 'every world must be committed');

    // The volume: a committed world beside Valheim's own automatic backup, the
    // hourly zips (the newest still being written), BepInEx and the lists.
    const vRoute = (folder, entries) => ({
      match: (r) => r.method === 'get' && r.url === `${NODE}/apps/getfolderinfo/${VAPP}/${VCOMP}/${encodeURIComponent(folder)}`,
      reply: () => (entries ? success(entries) : missing()),
    });
    const valheimVolume = (world = committed, extraWorlds = []) => [
      vRoute('appdata', [
        dir('worlds_local', 0), dir('backups', 0), dir('bepinex', 0), file('prefs', 775),
        file('adminlist.txt', 39), file('bannedlist.txt', 40), file('permittedlist.txt', 42), dir('sync-conflicts', 0),
      ]),
      vRoute('appdata/worlds_local', [
        dir('localhost', 7800000), dir('localhost_backup_auto-20261013120000', 7800000), ...extraWorlds,
      ]),
      vRoute('appdata/worlds_local/localhost', world),
      vRoute('appdata/backups', [
        file('worlds-20261013-160501.zip', 4644289, 125),
        file('worlds-20261013-170502.zip', 4650000, 65),
        file('worlds-20261013-180503.zip', 4700000, 2),
        file('README.txt', 10, 1),
      ]),
      vRoute('appdata/bepinex', [dir('plugins', 120000), file('BepInEx.cfg', 900)]),
      vRoute('appdata/valheimplus', null),
      {
        match: (r) => r.url.startsWith(`${NODE}/apps/createfolder/`),
        reply: () => ({ status: 200, headers: {}, data: { status: 'success', data: {} } }),
      },
      {
        match: (r) => r.method === 'post' && r.url === `${NODE}/apps/compressobject`,
        reply: () => ({ status: 202, headers: {}, data: { status: 'success', data: { jobId: 'job-v' } } }),
      },
      {
        match: (r) => r.url === `${NODE}/apps/operations/job-v`,
        reply: () => success({ status: 'Succeeded' }),
      },
    ];

    calls.length = 0;
    routes = valheimVolume();
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', VAPP, VCOMP, valheim, []);
    assert.deepStrictEqual(outcome, { fits: true });
    assert.deepStrictEqual(calls.find((r) => r.url.endsWith('/apps/compressobject')).data, {
      appname: VAPP,
      component: VCOMP,
      source: [
        'appdata/.flux-backup',
        'appdata/worlds_local/localhost',
        'appdata/backups/worlds-20261013-170502.zip',
        'appdata/bepinex',
        'appdata/prefs',
        'appdata/adminlist.txt',
        'appdata/bannedlist.txt',
        'appdata/permittedlist.txt',
      ],
      destination: `backup/local/backup_${VCOMP}.tar.gz`,
      overwrite: true,
    });
    const listedFolders = calls.filter((r) => r.url.includes('/apps/getfolderinfo/')).map((r) => decodeURIComponent(r.url.split('/').pop()));
    assert(!listedFolders.some((folder) => folder.includes('_backup_auto')), "Valheim's own backups are never listed");
    assert.strictEqual(listedFolders.filter((folder) => folder === 'appdata').length, 1, 'appdata is listed once for every file entry');

    // The standby caught half-way through a save -> the full backup.
    calls.length = 0;
    routes = valheimVolume(halfSynced);
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', VAPP, VCOMP, valheim, []);
    assert.strictEqual(outcome.fits, false);
    assert.match(outcome.reason, /^worlds_local: localhost has _main\.852\.ok but no _main\.852\.db2/);
    assert(!calls.some((r) => r.url.endsWith('/apps/compressobject')));

    // More world folders than are worth checking -> the full backup.
    const many = Array.from({ length: backupProfiles.MAX_CHILD_FOLDERS }, (_, i) => dir(`w${i}`, 1));
    routes = [...many.map((d) => vRoute(`appdata/worlds_local/${d.name}`, committed)), ...valheimVolume(committed, many)];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', VAPP, VCOMP, valheim, []);
    assert.match(outcome.reason, /more than 20 folders/);

    // No settled hourly zip yet (a new server): the worlds alone.
    const plan2 = backupProfiles.planProfiledArchive(valheim, {
      worlds_local: [dir('localhost', 1, committed)],
      backups: [file('worlds-20261013-180503.zip', 4700000, 2)],
      bepinex: null,
      valheimplus: null,
      prefs: null,
      'adminlist.txt': null,
      'bannedlist.txt': null,
      'permittedlist.txt': null,
    });
    assert.deepStrictEqual(plan2, { fits: true, sources: ['appdata/.flux-backup', 'appdata/worlds_local/localhost'] });

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

    // Not in the discovery cache, and the chain's enterprise spec has an empty
    // compose: the names alone still resolve it.
    routes = [{
      match: (r) => r.url.startsWith('https://api.runonflux.io/apps/appspecifications/'),
      reply: () => success({ name: 'dragonwilds1790000000001', version: 8, compose: [] }),
    }];
    const fromNames = await backupHooks.resolveBackupProfiles('dragonwilds1790000000001', ['dragonwildsdragonwilds']);
    assert.strictEqual(fromNames.dragonwildsdragonwilds.id, 'dragonwilds-world');

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
