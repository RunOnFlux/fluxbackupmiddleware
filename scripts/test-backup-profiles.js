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
    assert.strictEqual(byComponent('enshrouded', { repotag: 'mornedhels/enshrouded-server:latest', appname: 'enshrouded1' }), null);

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
    // Clearing the archive slot before a fallback: removeobject answers success
    // whether or not the file was there.
    const stalePath = `backup/local/backup_${COMPONENT}.tar.gz`;
    const removeRoute = (reply = () => success({})) => ({
      match: (r) => r.method === 'get' && r.url === `${NODE}/apps/removeobject/${APP}/${COMPONENT}/${encodeURIComponent(stalePath)}`,
      reply,
    });
    const clearedBeforeFullBackup = () => {
      const removed = calls.findIndex((r) => r.url.includes('/apps/removeobject/'));
      const full = calls.findIndex((r) => r.url.endsWith('/apps/appendbackuptask'));
      return removed !== -1 && full !== -1 && removed < full;
    };

    calls.length = 0;
    routes = [...worldFolders(), anyCreateFolder, ...compressRoute(['Succeeded']), ...listingRoutes];
    let result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.components[0].profile, 'dragonwilds-world');
    assert.strictEqual(result.components[0].backups.size, 74125);
    assert(!calls.some((r) => r.url.endsWith('/apps/appendbackuptask')), 'a profiled backup never stops the app for a full archive');
    assert(!calls.some((r) => r.url.includes('/apps/removeobject/')), 'a profiled backup keeps its archive');

    // Layout mismatch -> the full backup, exactly as before.
    calls.length = 0;
    const fullBackupRoute = {
      match: (r) => r.url === `${NODE}/apps/appendbackuptask`,
      reply: () => ({ status: 200, headers: {}, data: 'Finalizing...\n' }),
    };
    routes = [...worldFolders([]), removeRoute(), fullBackupRoute, ...listingRoutes];
    result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.components[0].profile, null);
    const full = calls.find((r) => r.url.endsWith('/apps/appendbackuptask'));
    assert.deepStrictEqual(full.data, { appname: APP, backup: [{ component: COMPONENT, backup: true }] });
    assert(result.diagnostics.some((d) => d.outcome === 'skipped' && /dragonwilds-world does not fit/.test(d.detail)));
    assert(clearedBeforeFullBackup(), 'the archive slot is cleared before the full backup');

    // The slot cannot be cleared -> this attempt fails, never a partial archive
    // uploaded as a full one.
    calls.length = 0;
    routes = [
      ...worldFolders([]),
      removeRoute(() => ({ status: 200, headers: {}, data: { status: 'error', data: { message: 'Refused: volume busy' } } })),
      fullBackupRoute,
      ...listingRoutes,
    ];
    result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.notStrictEqual(result && result.status, 'completed');
    assert(!calls.some((r) => r.url.endsWith('/apps/appendbackuptask')));
    assert(!calls.some((r) => r.url.startsWith(`${NODE}/backup/getlocalbackuplist/`)));
    const removeEndpoint = `${NODE}/apps/removeobject/${APP}/${COMPONENT}/${encodeURIComponent(stalePath)}`;
    assert(result.diagnostics.some((d) => d.outcome === 'failed' && d.endpoint === removeEndpoint && /removeobject refused: Refused: volume busy/.test(d.detail || d.error || JSON.stringify(d))), 'the failure names removeobject, not appendbackuptask');

    // removeobject answers like the other file operations: a 503 while another
    // operation holds the volume is waited out, a 202 job is followed to its end.
    const removeJob = (statuses) => {
      let polls = 0;
      return {
        match: (r) => r.method === 'get' && r.url === `${NODE}/apps/operations/rm-1`,
        reply: () => { const status = statuses[Math.min(polls, statuses.length - 1)]; polls += 1; return success({ status, error: status === 'Failed' ? { detail: 'rm: Permission denied' } : undefined }); },
      };
    };
    const sequence = (...replies) => { let served = 0; return () => { const reply = replies[Math.min(served, replies.length - 1)]; served += 1; return reply(); }; };
    const busy = () => ({ status: 503, headers: { 'retry-after': '1' }, data: { status: 'error', data: { message: 'busy' } } });
    const accepted = () => ({ status: 202, headers: {}, data: { status: 'success', data: { jobId: 'rm-1' } } });

    calls.length = 0;
    routes = [...worldFolders([]), removeRoute(sequence(busy, () => success({}))), fullBackupRoute, ...listingRoutes];
    result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.strictEqual(result.status, 'completed', 'a busy volume is waited out');
    assert.strictEqual(calls.filter((r) => r.url === removeEndpoint).length, 2);

    calls.length = 0;
    routes = [...worldFolders([]), removeRoute(accepted), removeJob(['Running', 'Succeeded']), fullBackupRoute, ...listingRoutes];
    result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.strictEqual(result.status, 'completed', 'a slow removal is followed to its end');
    assert(clearedBeforeFullBackup());
    const removalDone = calls.map((r) => r.url).lastIndexOf(`${NODE}/apps/operations/rm-1`);
    assert(removalDone < calls.findIndex((r) => r.url.endsWith('/apps/appendbackuptask')), 'the full backup waits for the removal');

    calls.length = 0;
    routes = [...worldFolders([]), removeRoute(accepted), removeJob(['Failed']), fullBackupRoute, ...listingRoutes];
    result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.notStrictEqual(result && result.status, 'completed', 'a removal job that fails fails the attempt');
    assert.match(result.error, /removeobject Failed: rm: Permission denied/);
    assert(!calls.some((r) => r.url.endsWith('/apps/appendbackuptask')));

    // The node cannot write the partial archive -> the full backup, not no backup.
    calls.length = 0;
    routes = [
      ...worldFolders(),
      anyCreateFolder,
      {
        match: (r) => r.url === `${NODE}/apps/compressobject`,
        reply: () => ({ status: 404, headers: {}, data: 'Cannot POST /apps/compressobject' }),
      },
      removeRoute(),
      fullBackupRoute,
      ...listingRoutes,
    ];
    result = await fluxOS.createBackupTaskOnNode(NODE, 'auth', APP, [COMPONENT], { [COMPONENT]: profile });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.components[0].profile, null);
    assert(calls.some((r) => r.url.endsWith('/apps/appendbackuptask')));
    assert(result.diagnostics.some((d) => d.outcome === 'skipped' && /dragonwilds-world archive failed: .*older than 8\.18/.test(d.detail)));
    assert(clearedBeforeFullBackup());

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
    // Every refusal but "no world" is a sync caught half-way: unsettled.
    const unsettledReason = (problem) => {
      assert.strictEqual(problem && problem.unsettled, true, `unsettled: ${JSON.stringify(problem)}`);
      return problem.reason;
    };
    assert.strictEqual(worlds.validate([dir('localhost', 7800000, committed)]), null);
    assert.match(unsettledReason(worlds.validate([dir('Vally2026', 170000, halfSynced)])), /_main\.852\.ok but no _main\.852\.db2 \(a half-synced save\)/);
    assert.match(unsettledReason(worlds.validate([dir('W', 10, [file('_main.1.db2', 9)])])), /no _main\.N\.ok/, 'a first save in progress');
    assert.strictEqual(worlds.validate([file('Old.db', 9000), file('Old.fwl', 40)]), null, 'a pre-1.0 world');
    assert.match(unsettledReason(worlds.validate([file('Old.db', 9000)])), /Old\.db has no Old\.fwl/);
    assert.strictEqual(worlds.validate([]), 'no world');
    assert.strictEqual(worlds.validate([dir('empty', 0, [])]), 'no world');
    assert.strictEqual(worlds.validate([dir('localhost', 1, committed), dir('Vally2026', 1, halfSynced)]) !== null, true, 'every world must be committed');
    // The next save half-arrived: a chunk newer than the committed .ok. Its
    // .ok is at 60 minutes ago; a chunk written a minute later is not this save.
    assert.match(
      unsettledReason(worlds.validate([dir('localhost', 1, [...committed, file('20_1e__1_2.chunk', 593380, 59)])])),
      /localhost\/20_1e__1_2\.chunk is newer than _main\.260\.ok/,
    );
    assert.strictEqual(worlds.validate([dir('localhost', 1, [...committed.slice(0, -1), file('1f_1e__1_1.chunk', 900, 59.95)])]), null, 'within the tolerance of one save');
    assert.strictEqual(worlds.validate([dir('localhost', 1, [...committed, file('_main.261.sync-conflict-20261014-071000-AAAAAAA.db2', 9, 1)])]), null, 'a newer conflict copy is not a save');
    const timeless = committed.map((entry) => ({ ...entry, modifiedAt: undefined }));
    assert.strictEqual(worlds.validate([dir('localhost', 1, timeless)]), null, 'no modifiedAt: the generation check alone');
    // Syncthing still writing a file, inside a world folder or beside it.
    assert.match(unsettledReason(worlds.validate([dir('localhost', 1, [...committed, file('.syncthing._main.261.db2.tmp', 9, 0)])])), /localhost\/\.syncthing\._main\.261\.db2\.tmp is still being synced/);
    assert.match(unsettledReason(worlds.validate([dir('localhost', 1, [...committed, file('~syncthing~1e_1e__1_46.chunk.tmp', 9, 0)])])), /still being synced/);
    assert.match(unsettledReason(worlds.validate([file('Old.db', 9000), file('Old.fwl', 40), file('.syncthing.Old.db.tmp', 9000, 0)])), /\.syncthing\.Old\.db\.tmp is still being synced/);
    // planProfiledArchive carries the flag; a plain-string refusal does not.
    const vPlan = (worldsListing) => backupProfiles.planProfiledArchive(valheim, {
      worlds_local: worldsListing, backups: null, bepinex: null, valheimplus: null, prefs: null, 'adminlist.txt': null, 'bannedlist.txt': null, 'permittedlist.txt': null,
    });
    assert.deepStrictEqual(vPlan([dir('Vally2026', 1, halfSynced)]), {
      fits: false, reason: 'worlds_local: Vally2026 has _main.852.ok but no _main.852.db2 (a half-synced save)', unsettled: true,
    });
    assert.deepStrictEqual(vPlan([]), { fits: false, reason: 'worlds_local: no world' });

    // sameListings: by name, kind, size and modifiedAt, inside listed folders too.
    const listingsA = { worlds_local: [dir('localhost', 1, committed)], prefs: file('prefs', 775), bepinex: null };
    assert(backupProfiles.sameListings(listingsA, JSON.parse(JSON.stringify(listingsA))));
    assert(!backupProfiles.sameListings(listingsA, { ...listingsA, worlds_local: [dir('localhost', 1, [...committed.slice(1), { ...committed[0], size: 184 }])] }), 'a chunk rewritten');
    assert(!backupProfiles.sameListings(listingsA, { ...listingsA, worlds_local: [dir('localhost', 1, [...committed, file('x.chunk', 1)])] }), 'a chunk added');
    assert(!backupProfiles.sameListings(listingsA, { ...listingsA, bepinex: [] }), 'a folder appeared');
    assert(!backupProfiles.sameListings(listingsA, { ...listingsA, prefs: { ...listingsA.prefs, modifiedAt: new Date().toISOString() } }), 'a file touched');

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
    assert.strictEqual(listedFolders.filter((folder) => folder === 'appdata').length, 2, 'appdata is listed once for every file entry, before and after the archive');
    assert.strictEqual(calls.filter((r) => r.url.endsWith('/apps/compressobject')).length, 1, 'nothing changed: one archive');
    // A world folder whose listing answers each time with the next of `replies`
    // (the last one repeats), in front of the volume above.
    const worldListedAs = (...replies) => {
      let served = 0;
      return {
        match: (r) => r.method === 'get' && r.url === `${NODE}/apps/getfolderinfo/${VAPP}/${VCOMP}/${encodeURIComponent('appdata/worlds_local/localhost')}`,
        reply: () => { const entries = replies[Math.min(served, replies.length - 1)]; served += 1; return success(entries); },
      };
    };
    const compressions = () => calls.filter((r) => r.url.endsWith('/apps/compressobject')).length;
    const worldListings = () => calls.filter((r) => r.url.endsWith(encodeURIComponent('appdata/worlds_local/localhost'))).length;
    const nextSave = [...committed, file('1e_1e__1_47.chunk', 1142295, 1)];
    const nextSaveCommitted = [...nextSave.filter((entry) => !/^_main\.260\./.test(entry.name)),
      file('_main.261.chunks', 197, 1), file('_main.261.db2', 149852, 1), file('_main.261.fwl2', 1563, 1), file('_main.261.ok', 4, 1)];

    // Caught half-way, whole when listed again after the wait: the profile still.
    calls.length = 0;
    routes = [worldListedAs(halfSynced, committed), ...valheimVolume()];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', VAPP, VCOMP, valheim, []);
    assert.deepStrictEqual(outcome, { fits: true });
    assert.strictEqual(worldListings(), 3, 'half-synced, listed again after the wait, then after the archive');
    assert.strictEqual(compressions(), 1);

    // A save arrived while the archive was being written: written again from the
    // new listing, and kept once a listing after it matches.
    calls.length = 0;
    routes = [worldListedAs(committed, nextSaveCommitted), ...valheimVolume()];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', VAPP, VCOMP, valheim, []);
    assert.deepStrictEqual(outcome, { fits: true });
    assert.strictEqual(compressions(), 2, 'the first archive may hold half a save');
    assert.strictEqual(worldListings(), 3);

    // The volume changes under every attempt: the full backup.
    calls.length = 0;
    const touched = (minutesAgo) => committed.map((entry) => (entry.name === '_main.260.ok' ? file(entry.name, 4, minutesAgo) : entry));
    routes = [worldListedAs(committed, touched(50), touched(40)), ...valheimVolume()];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', VAPP, VCOMP, valheim, []);
    assert.deepStrictEqual(outcome, { fits: false, changing: true, reason: 'the files changed while archiving, 2 times' });
    assert.strictEqual(compressions(), 2);

    // What arrived while archiving is a save half-way: waited for like the first
    // listing, then archived again once it is whole.
    calls.length = 0;
    routes = [worldListedAs(committed, nextSave, nextSaveCommitted), ...valheimVolume()];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', VAPP, VCOMP, valheim, []);
    assert.deepStrictEqual(outcome, { fits: true });
    assert.strictEqual(compressions(), 2);
    assert.strictEqual(worldListings(), 4, 'before, after the archive (half a save), after the wait, after the second archive');

    // ... and when it is still half-way after the wait: the full backup, no third archive.
    calls.length = 0;
    routes = [worldListedAs(committed, nextSave), ...valheimVolume()];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', VAPP, VCOMP, valheim, []);
    assert.strictEqual(outcome.fits, false);
    assert.strictEqual(outcome.unsettled, true);
    assert.match(outcome.reason, /1e_1e__1_47\.chunk is newer than _main\.260\.ok/);
    assert.strictEqual(compressions(), 1);

    // The standby caught half-way through a save -> the full backup.
    calls.length = 0;
    routes = valheimVolume(halfSynced);
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', VAPP, VCOMP, valheim, []);
    assert.strictEqual(outcome.fits, false);
    assert.match(outcome.reason, /^worlds_local: localhost has _main\.852\.ok but no _main\.852\.db2/);
    assert.strictEqual(outcome.unsettled, true);
    assert.strictEqual(worldListings(), 2, 'listed again after the wait before giving up');
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

    // --- Palworld -------------------------------------------------------------------
    const PAPP = 'palworld1790000000000';
    const PCOMP = 'palworldpalworld';
    const palworld = backupProfiles.profileForComponent({
      appname: PAPP, component: PCOMP, repotag: null, componentCount: 1,
    });
    assert.strictEqual(palworld.id, 'palworld-world', 'marketplace component');
    assert.strictEqual(byComponent('palworld').id, 'palworld-world', 'hub plan component');
    assert.strictEqual(byComponent('web', { repotag: 'runonflux/palworld-server-flux:latest' }).id, 'palworld-world');
    assert.strictEqual(byComponent('valheimvalheim').id, 'valheim-world', 'Valheim still its own');

    // One save: every file of Players/ and the two Level files in the same second
    // (palworld1788788877472, 2026-10-14). `ago` in minutes.
    const SAVED = 3;
    const at = (minutesAgo, seconds = 0) => new Date(Date.now() - minutesAgo * 60000 + seconds * 1000).toISOString();
    const pFile = (name, size, modifiedAt) => ({
      name, size, isFile: true, isDirectory: false, modifiedAt,
    });
    const pDir = (name, size, extra = {}) => ({
      name, size, isFile: false, isDirectory: true, modifiedAt: at(SAVED), ...extra,
    });
    const players = [
      pFile('0F150E1B000000000000000000000000.sav', 14133, at(SAVED)),
      pFile('488F5019000000000000000000000000_dps.sav', 33554, at(SAVED, 0.4)),
    ];
    const worldFiles = (playerFiles = players, extra = []) => [
      pFile('Level.sav', 4587627, at(SAVED, 1)), pFile('LevelMeta.sav', 1931, at(SAVED, 1)),
      pFile('LocalData.sav', 50327, at(40)), pDir('Players', 667270, { children: playerFiles }), ...extra,
    ];
    const pWorld = (files = worldFiles(), excluded = [pDir('backup', 129857180)]) => pDir('C52D1EBB4AE561E5C1BF519CB56B3101', 134795822, {
      children: files, excludedChildren: excluded,
    });
    const pWorlds = palworld.include[0];
    assert.strictEqual(pWorlds.validate([pWorld()]), null);
    assert.strictEqual(pWorlds.validate([pWorld(), pDir('14ADF22A4F2E4A0B9F2D3E5E6A7B8C9D', 0, { children: [], excludedChildren: [] })]), null, 'an empty GUID folder is not checked');
    assert.strictEqual(pWorlds.validate([]), 'no world');
    assert.strictEqual(pWorlds.validate([pDir('E', 0, { children: [], excludedChildren: [] })]), 'no world');
    // Mid-save on the primary, or arriving on the standby.
    assert.match(unsettledReason(pWorlds.validate([pWorld(worldFiles(), [pDir('backup', 1), pFile('Level.sav.new_tmp', 4578572, at(2))])])), /Level\.sav\.new_tmp: a save is still being written or synced/);
    assert.match(unsettledReason(pWorlds.validate([pWorld(worldFiles(), [pDir('world_save_temp', 4914137, { modifiedAt: at(2) })])])), /world_save_temp/);
    assert.match(unsettledReason(pWorlds.validate([pWorld(worldFiles(), [pFile('.syncthing..atomic_save_update_manifest_world.json.tmp', 582, at(SAVED, 30))])])), /atomic_save_update_manifest/);
    // ... but not one a sync gave up on hours ago (64.235.94.187: 06:37 and 09:02
    // beside a Level.sav of 10:28).
    assert.strictEqual(pWorlds.validate([pWorld(worldFiles(), [
      pFile('.syncthing.Level.sav.new_tmp.tmp', 3032089, at(230)), pFile('.syncthing..atomic_save_update_manifest_world.json.tmp', 582, at(90)),
    ])]), null, 'abandoned temporary files');
    assert.match(unsettledReason(pWorlds.validate([pWorld(worldFiles(players.map((f) => ({ ...f, modifiedAt: at(SAVED - 1) }))))])), /Players\/0F150E1B.* is not from the same save/, 'the next save half-arrived');
    assert.match(unsettledReason(pWorlds.validate([pWorld(worldFiles([...players, pFile('A008CC54000000000000000000000000.sav', 6332, at(SAVED + 1))]))])), /A008CC54.* is not from the same save/, 'a player from the save before');
    assert.strictEqual(pWorlds.validate([pWorld(worldFiles([...players, pFile('DB2C1001000000000000000000000000.sav', 30604, at(SAVED + 1088))]))]), null, 'a character the world no longer rewrites');
    assert.match(unsettledReason(pWorlds.validate([pWorld(worldFiles([...players, pFile('.syncthing.DB2C1001000000000000000000000000.sav.tmp', 9, at(1))]))])), /Players\/\.syncthing\..* is still being synced/);
    assert.match(unsettledReason(pWorlds.validate([pWorld([pFile('Level.sav', 9, at(SAVED)), pFile('LevelMeta.sav', 1931, at(SAVED + 1))])])), /LevelMeta\.sav is not from the same save/);
    assert.match(unsettledReason(pWorlds.validate([pWorld([pFile('Level.sav', 9, at(SAVED))])])), /no LevelMeta\.sav/);

    // The volume, as listed on a standby.
    const W = 'C52D1EBB4AE561E5C1BF519CB56B3101';
    const pRoute = (folder, entries) => ({
      match: (r) => r.method === 'get' && r.url === `${NODE}/apps/getfolderinfo/${PAPP}/${PCOMP}/${encodeURIComponent(folder)}`,
      reply: () => (entries ? success(entries) : missing()),
    });
    const strip = (entries) => entries.map(({ children, ...rest }) => rest);
    const palworldVolume = (files = worldFiles()) => [
      pRoute('appdata/SaveGames/0', [pDir(W, 134795822), pDir('backup', 3862)]),
      pRoute(`appdata/SaveGames/0/${W}`, [...strip(files), pDir('backup', 129857180), pDir('world_save_bak', 4727876),
        pFile('.syncthing.Level.sav.new_tmp.tmp', 3032089, at(230))]),
      pRoute(`appdata/SaveGames/0/${W}/Players`, players),
      pRoute(`appdata/SaveGames/0/${W}/backup/world`, [
        pDir('2026.10.07-16.16.49', 4900000, { modifiedAt: at(10000) }),
        pDir('2026.10.14-11.49.42', 4900000, { modifiedAt: at(34) }),
        pDir('2026.10.14-11.59.42', 4900000, { modifiedAt: at(24) }),
        pDir('2026.10.14-12.21.42', 4900000, { modifiedAt: at(2) }),
      ]),
      pRoute('appdata/Config/LinuxServer', [pFile('PalWorldSettings.ini', 3588, at(400)), pFile('GameUserSettings.ini', 1859, at(400))]),
      {
        match: (r) => r.url.startsWith(`${NODE}/apps/createfolder/`),
        reply: () => ({ status: 200, headers: {}, data: { status: 'success', data: {} } }),
      },
      {
        match: (r) => r.method === 'post' && r.url === `${NODE}/apps/compressobject`,
        reply: () => ({ status: 202, headers: {}, data: { status: 'success', data: { jobId: 'job-p' } } }),
      },
      {
        match: (r) => r.url === `${NODE}/apps/operations/job-p`,
        reply: () => success({ status: 'Succeeded' }),
      },
    ];
    calls.length = 0;
    routes = palworldVolume();
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', PAPP, PCOMP, palworld, []);
    assert.deepStrictEqual(outcome, { fits: true });
    assert.deepStrictEqual(calls.find((r) => r.url.endsWith('/apps/compressobject')).data.source, [
      'appdata/.flux-backup',
      `appdata/SaveGames/0/${W}/Level.sav`,
      `appdata/SaveGames/0/${W}/LevelMeta.sav`,
      `appdata/SaveGames/0/${W}/LocalData.sav`,
      `appdata/SaveGames/0/${W}/Players`,
      // The newest restore point at least ten minutes old.
      `appdata/SaveGames/0/${W}/backup/world/2026.10.14-11.59.42`,
      'appdata/Config/LinuxServer',
    ]);
    const pListed = calls.filter((r) => r.url.includes('/apps/getfolderinfo/')).map((r) => decodeURIComponent(r.url.split('/').pop()));
    assert(!pListed.includes('appdata/SaveGames/0/backup'), 'the stray restore point folder is not a world');
    assert(!pListed.some((folder) => folder.endsWith('world_save_bak')));
    assert.strictEqual(compressions(), 1, 'nothing changed: one archive');

    // The game writes a restore point every minute: a new one, or one more
    // pruned, between the listing and the check after the archive, is not a
    // change to what was archived.
    const listingsP = await backupProfiles.collectProfileListings(palworld, (folder) => {
      const route = palworldVolume().find((r) => r.match({ method: 'get', url: `${NODE}/apps/getfolderinfo/${PAPP}/${PCOMP}/${encodeURIComponent(`appdata/${folder}`)}` }));
      return route ? route.reply().data.data || null : null;
    });
    const later = JSON.parse(JSON.stringify(listingsP));
    later['SaveGames/0'][0].size += 4900000;
    later['SaveGames/0'][0].modifiedAt = at(0);
    later['SaveGames/0'][0].excludedChildren[1].size += 4900000;
    later['SaveGames/0'][0].latestCandidates.push(pDir('2026.10.14-12.22.42', 4900000, { modifiedAt: at(1) }));
    assert(backupProfiles.sameListings(listingsP, later), 'only the restore points changed');
    const resaved = JSON.parse(JSON.stringify(listingsP));
    resaved['SaveGames/0'][0].children[0].modifiedAt = at(0);
    assert(!backupProfiles.sameListings(listingsP, resaved), 'a new save is a change');

    // Mid-save on the standby -> waited for, then archived.
    calls.length = 0;
    let served = 0;
    routes = [{
      match: (r) => r.method === 'get' && r.url === `${NODE}/apps/getfolderinfo/${PAPP}/${PCOMP}/${encodeURIComponent(`appdata/SaveGames/0/${W}`)}`,
      reply: () => {
        served += 1;
        return success(served === 1 ? [...strip(worldFiles()), pFile('.syncthing.LevelMeta.sav.new_tmp.tmp', 1931, at(0))] : strip(worldFiles()));
      },
    }, ...palworldVolume()];
    outcome = await fluxOS.testHooks.createProfiledArchiveOnNode(NODE, 'auth', PAPP, PCOMP, palworld, []);
    assert.deepStrictEqual(outcome, { fits: true });
    assert.strictEqual(served, 3, 'mid-save, listed again after the wait, then after the archive');

    // A world with more folders inside than are worth listing -> the full backup.
    const crowded = Array.from({ length: backupProfiles.MAX_CHILD_FOLDERS + 1 }, (_, i) => pDir(`Players.pre-restore-${i}`, 1));
    const crowdedListings = await backupProfiles.collectProfileListings(palworld, async (folder) => {
      if (folder === 'SaveGames/0') return [pDir(W, 1)];
      if (folder === `SaveGames/0/${W}`) return [...strip(worldFiles()), ...crowded];
      return [];
    });
    assert.match(backupProfiles.planProfiledArchive(palworld, crowdedListings).reason, /more than 20 folders/);

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
