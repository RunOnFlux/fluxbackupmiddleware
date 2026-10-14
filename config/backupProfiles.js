/**
 * Backup profiles: apps whose automatic backup archives only the data that
 * cannot be fetched again, instead of the component's whole appdata.
 *
 * A profile is matched to a component by `match`, the same rule the games hub
 * (runonflux.com/games, src/games/catalog.js) uses to tell which game an app is,
 * so the two never disagree. Each is a case-insensitive regular expression and
 * ANY one of them is enough:
 *
 *   component  the component's name
 *   repotag    the component's image, when it is known (enterprise apps only
 *              have it once discovery has decrypted the spec)
 *   name       the app's name, for a single-component app only: in an app with
 *              several, it says nothing about which component is the game
 *
 * Matching names the GAME, not the image, on purpose: the image can change
 * (our own build replacing a community one) without the game's data moving.
 * What the profile relies on is the layout of the volume, and that is checked
 * on the node before every backup (`required`, `mustContain` below). A
 * component that matches but does not have the layout gets the full backup,
 * so a wider match can only ever cost a full backup, never lose data.
 *
 * `include` lists paths RELATIVE TO THE COMPONENT'S APPDATA, so the archive has
 * the same layout as the full one FluxOS's appendbackuptask writes: a restore
 * that unpacks it into appdata puts every file back where it was.
 *
 * What is left out has to be something the container rebuilds by itself on
 * start - typically a game server's install, which the image downloads again
 * from Steam. A path the app writes and nothing else can recreate belongs in
 * `include`.
 *
 *   path         the directory, relative to appdata ('' for appdata itself,
 *                with `children`)
 *   required     the profile does not fit this app unless the directory exists
 *   mustContain  a file name pattern at least one non-empty file must match,
 *                so a copy that holds no world is never taken as a backup
 *   file         `path` names a FILE rather than a directory
 *   latest       { name, settledMs }: archive only the newest non-empty file
 *                of the directory whose name matches, leaving out one modified
 *                within settledMs (still being written)
 *   children     archive each entry of the directory on its own instead of the
 *                directory, leaving out those matching `excludeChildren`; its
 *                folders are listed one level deeper for `validate`. On restore
 *                each archived child is replaced as a whole and the rest of the
 *                directory is left alone
 *   excludeWithin  with `children`: a child FOLDER is archived as what it
 *                holds, each entry on its own, leaving out those matching; the
 *                folders kept inside it are listed in turn for `validate`, and
 *                what is left out is passed to it as `excludedChildren`. On
 *                restore only the archived entries are replaced, so what was
 *                left out stays as the node has it
 *   latestWithin { path, name, settledMs, directory }: with `excludeWithin`,
 *                also archive the newest settled entry of `<child>/<path>`
 *                whose name matches, as `latest` does (a folder when
 *                `directory`), even though `path` itself is left out
 *   validate     (listing, now) => null when the listing is fit to archive, or the
 *                reason it is not: a string, or { reason, unsettled: true } when
 *                the files are still arriving (a sync caught half-way), which is
 *                worth listing again shortly before taking the full backup
 *
 * When a required path is missing, holds nothing that matches or fails its
 * `validate`, the app does not have the layout the profile was written for (an
 * older image, a server that has not saved yet, a save caught half-synced), and
 * the backup falls back to the full archive.
 *
 * A profile assumes a g: app: backups are taken on the secondary, where the
 * container does not run, so nothing is written while the paths are archived.
 */

/** Syncthing writes a file under one of these names and renames it when it is whole. */
const SYNCTHING_TEMP = /^(\.syncthing\..*\.tmp|~syncthing~.*\.tmp)$/;
const SYNC_CONFLICT = /\.sync-conflict-/;
/** modifiedAt has whole seconds; a save writes all of its files within one. */
const SAVE_TOLERANCE_MS = 5000;

/**
 * Whether every Valheim world in worlds_local is a committed save.
 *
 * Since 1.0 a world is a folder of chunks whose save generation N is committed
 * by `_main.N.ok`, written last; `_main.N.db2`, `.chunks` and `.fwl2` are the
 * same generation, and the `*.chunk` files it rewrote are written before them
 * (the server logs "Chunks writing done" before the DB2). Backups are taken on
 * the standby, which has been caught holding a new `.ok` beside the previous
 * generation's `.db2` (Syncthing half-way through a save): archived, that loads
 * as a brand new world. The other half of the same race is a chunk of the next
 * save that has arrived before its `.ok`: newer than the committed `.ok`. A
 * world from before 1.0 is the flat pair `<name>.db` + `<name>.fwl`.
 *
 * Every refusal here but "no world" is a sync caught half-way, so `unsettled`:
 * Syncthing finishes a save in seconds, and listing again shortly after
 * usually finds it whole.
 *
 * Sync-conflict copies (`_main.890.sync-conflict-....db2`) match none of the
 * names below and are moved out of the folder by the spec's start hook.
 */
function valheimWorldsCommitted(listing) {
  const unsettled = (reason) => ({ reason, unsettled: true });
  const time = (file) => Date.parse(file.modifiedAt);
  let worlds = 0;
  for (let i = 0; i < listing.length; i += 1) {
    const item = listing[i];
    if (item.isFile && SYNCTHING_TEMP.test(String(item.name))) {
      return unsettled(`${item.name} is still being synced`);
    }
    if (item.isDirectory) {
      const files = (item.children || []).filter((file) => file && file.isFile);
      const syncing = files.find((file) => SYNCTHING_TEMP.test(String(file.name)));
      if (syncing) return unsettled(`${item.name}/${syncing.name} is still being synced`);
      const byName = new Map(files.map((file) => [String(file.name), file]));
      const generations = [...byName.keys()]
        .map((name) => /^_main\.(\d+)\.ok$/.exec(name))
        .filter(Boolean)
        .map((found) => Number(found[1]));
      if (generations.length === 0) {
        // A folder with save files but no marker is a first save in progress.
        if ([...byName.keys()].some((name) => name.startsWith('_main.'))) {
          return unsettled(`${item.name} has save files but no _main.N.ok`);
        }
        // eslint-disable-next-line no-continue
        continue;
      }
      const n = Math.max(...generations);
      const missing = ['db2', 'chunks', 'fwl2'].find((ext) => !(Number(byName.get(`_main.${n}.${ext}`)?.size) > 0));
      if (missing) return unsettled(`${item.name} has _main.${n}.ok but no _main.${n}.${missing} (a half-synced save)`);
      const committedAt = time(byName.get(`_main.${n}.ok`));
      if (Number.isFinite(committedAt)) {
        const newer = files.find((file) => !SYNC_CONFLICT.test(String(file.name))
          && time(file) > committedAt + SAVE_TOLERANCE_MS);
        if (newer) return unsettled(`${item.name}/${newer.name} is newer than _main.${n}.ok (the next save half-synced)`);
      }
      worlds += 1;
    } else if (item.isFile && /\.db$/i.test(item.name) && Number(item.size) > 0) {
      const header = item.name.replace(/\.db$/i, '.fwl');
      if (!listing.some((file) => file.isFile && file.name === header && Number(file.size) > 0)) {
        return unsettled(`${item.name} has no ${header}`);
      }
      worlds += 1;
    }
  }
  return worlds > 0 ? null : 'no world';
}

/** Files a Palworld save exists under only while it is being written. */
const PALWORLD_SAVING = /\.new_tmp$|^\.atomic_save_update_manifest|^world_save_temp$/;
/**
 * A player's file from the save before the world's: older than Level.sav but
 * by less than this. Older still, it is a character the world no longer
 * rewrites (deleted on the primary, kept on the standby), seen 4 h and 18 h old.
 */
const PALWORLD_PREVIOUS_SAVE_MS = 15 * 60 * 1000;
/**
 * A world nothing in which has changed for this long is not being saved or
 * synced: waiting will not change it, and the full backup would hold the same
 * files. Its consistency checks are skipped. Seen 2026-10-14, all of them
 * refused for good otherwise: a final shutdown save whose LevelMeta.sav landed
 * 10 s and 30 s after Level.sav, a world_save_temp/ left by a save that died
 * five hours earlier, and a world folder the owner set aside, whose players
 * were never saved with it.
 */
const PALWORLD_QUIET_MS = 15 * 60 * 1000;

/**
 * Whether every Palworld world in SaveGames/0 is one committed save.
 *
 * A save (every AutoSaveSpan, 30 to 60 s on our servers) writes every file of
 * Players/ - every character, online or not - then `Level.sav.new_tmp` and
 * `LevelMeta.sav.new_tmp` beside a `world_save_temp/` folder and an
 * `.atomic_save_update_manifest_world.json`, and renames them over the old
 * ones, all within the same second (seen on 20 nodes, 2026-10-14). Syncthing
 * keeps those times on the standby, where backups are taken and where a save
 * is often caught half-arrived (half the standbys listed): `.syncthing.*.tmp`
 * files, the in-progress names above, or a world from one save beside players
 * from another. Every refusal but "no world" is such a sync caught half-way,
 * so `unsettled`.
 *
 * A world is a folder holding Level.sav. Folders without one (an unused GUID,
 * an empty world) are archived as they are and not checked, and so is a world
 * that has been quiet for PALWORLD_QUIET_MS: these checks are about a save in
 * flight. On a standby whose sync stopped half-way the live files can then be
 * two saves apart; the restore point archived beside them is one whole save.
 */
function palworldWorldsCommitted(listing, now = Date.now()) {
  const unsettled = (reason) => ({ reason, unsettled: true });
  const time = (file) => Date.parse(file.modifiedAt);
  let worlds = 0;
  for (let i = 0; i < listing.length; i += 1) {
    const item = listing[i];
    if (item.isFile && SYNCTHING_TEMP.test(String(item.name))) {
      return unsettled(`${item.name} is still being synced`);
    }
    if (item.isDirectory) {
      const inside = [...(item.children || []), ...(item.excludedChildren || [])].filter(Boolean);
      const players = inside.find((entry) => entry.isDirectory && entry.name === 'Players');
      const files = (players && players.children) || [];
      // The restore points are left out: the game adds one every minute
      // while it runs, whatever the state of the files around them.
      const changes = [...inside.filter((entry) => entry.name !== 'backup'), ...files]
        .map((entry) => time(entry)).filter(Number.isFinite);
      if (inside.some((entry) => entry.isFile && entry.name === 'Level.sav')
        && changes.length && now - Math.max(...changes) >= PALWORLD_QUIET_MS) {
        worlds += 1;
        // eslint-disable-next-line no-continue
        continue;
      }
      const byName = new Map(inside.filter((entry) => entry.isFile).map((entry) => [String(entry.name), entry]));
      const level = byName.get('Level.sav');
      const savedAt = level ? time(level) : NaN;
      // A temporary file last touched before the save now in place is one a
      // sync or a save gave up on: Syncthing leaves those for up to 24 hours,
      // and they were on most standbys listed (2026-10-14).
      const abandoned = (entry) => Number.isFinite(savedAt) && time(entry) < savedAt - SAVE_TOLERANCE_MS;
      const busy = inside.find((entry) => (SYNCTHING_TEMP.test(String(entry.name)) || PALWORLD_SAVING.test(String(entry.name)))
        && !abandoned(entry));
      if (busy) return unsettled(`${item.name}/${busy.name}: a save is still being written or synced`);
      if (level) {
        if (!(Number(level.size) > 0)) return unsettled(`${item.name}/Level.sav is empty`);
        const meta = byName.get('LevelMeta.sav');
        if (!(Number(meta?.size) > 0)) return unsettled(`${item.name} has Level.sav but no LevelMeta.sav`);
        if (Number.isFinite(savedAt)) {
          if (Math.abs(time(meta) - savedAt) > SAVE_TOLERANCE_MS) {
            return unsettled(`${item.name}/LevelMeta.sav is not from the same save as Level.sav`);
          }
          const syncing = files.find((file) => SYNCTHING_TEMP.test(String(file.name)) && !abandoned(file));
          if (syncing) return unsettled(`${item.name}/Players/${syncing.name} is still being synced`);
          const mismatched = files.find((file) => file.isFile && /\.sav$/i.test(String(file.name)) && (
            time(file) > savedAt + SAVE_TOLERANCE_MS
            || (time(file) < savedAt - SAVE_TOLERANCE_MS && time(file) > savedAt - PALWORLD_PREVIOUS_SAVE_MS)));
          if (mismatched) return unsettled(`${item.name}/Players/${mismatched.name} is not from the same save as Level.sav`);
        }
        worlds += 1;
      }
    }
  }
  return worlds > 0 ? null : 'no world';
}

module.exports = [
  {
    // RuneScape: Dragonwilds. The volume is the image's whole DepotDownloader
    // install (~5.4 GB, ~1.9 GB compressed); the world, its settings and the
    // owner's pak mods are well under 1 MB of it.
    id: 'dragonwilds-world',
    // As in the hub's catalogue. Components are `dragonwilds` in the hub's
    // plans and `dragonwildsdragonwilds` in the marketplace app; the image is
    // indifferentbroccoli/runescape-dragonwilds-server-docker today.
    match: { name: 'dragonwilds', repotag: 'dragonwilds', component: '^dragonwilds' },
    include: [
      // The world .sav files.
      { path: 'RSDragonwilds/Saved/SaveGames', required: true, mustContain: /\.sav$/i },
      // DedicatedServer.ini: rewritten from env on every start, except the
      // ServerGuid, which the image keeps from this file.
      { path: 'RSDragonwilds/Saved/Config' },
      // Pak mods the owner uploaded. Lives inside the install tree, but nothing
      // downloads it again.
      { path: 'RSDragonwilds/Content/Paks/~mods' },
    ],
  },
  {
    // Valheim on lloesche/valheim-server. appdata is the image's /config; the
    // server itself (/opt/valheim) is not on the volume. What makes the full
    // backup large is the image's own hourly archives: backups/worlds-*.zip,
    // one per hour for BACKUPS_MAX_AGE (3) days, ~72 copies of the world.
    id: 'valheim-world',
    // As in the hub's catalogue. Components are `valheim` in the hub's plans
    // and `valheimvalheim` in the marketplace app.
    match: { name: 'valheim', repotag: 'valheim|lloesche', component: '^valheim' },
    include: [
      // Each world, on its own: a 1.0 world folder or a pre-1.0 .db/.fwl pair.
      // Valheim's own automatic backups sit beside them (`<world>_backup_auto-*`)
      // and are left out, as the image's hourly zip leaves them out, and so are
      // Syncthing's conflict copies. A restore replaces each world folder
      // whole, which a chunked world needs: chunks left over from another save
      // corrupt it.
      {
        path: 'worlds_local',
        required: true,
        children: true,
        excludeChildren: /_backup_auto-|\.sync-conflict-/,
        validate: valheimWorldsCommitted,
      },
      // The newest hourly zip: taken on the primary between two saves, so a
      // committed world even when the standby's copy above was caught half-way.
      // The image writes it in place, so one younger than ten minutes may still
      // be open.
      { path: 'backups', latest: { name: /^worlds-\d{8}-\d{6}\.zip$/, settledMs: 10 * 60 * 1000 } },
      // Mods and their configs: plugins the owner uploaded are nowhere else.
      { path: 'bepinex' },
      { path: 'valheimplus' },
      // Unity preferences and the server's lists. adminlist.txt is rewritten
      // from ADMINLIST_IDS when that is set; the ban and permit lists are only here.
      { path: 'prefs', file: true },
      { path: 'adminlist.txt', file: true },
      { path: 'bannedlist.txt', file: true },
      { path: 'permittedlist.txt', file: true },
    ],
  },
  {
    // Palworld on thijsvanloef/palworld-server-docker or our layer over it,
    // runonflux/palworld-server-flux. appdata is Pal/Saved; the server itself
    // is in /palworld, off the volume, and the image's own backups are off
    // (BACKUP_ENABLED=false) and would be in /palworld/backups anyway. What
    // makes the full backup large is the game's own restore points:
    // SaveGames/0/<world>/backup/world/<time>/, a whole copy of the world
    // each, 25 to 35 of them (one a minute for the last few minutes, every ten
    // for the last hour, hourly for a day, daily for a week). Measured on 8
    // servers 2026-10-14: 13 to 129 MB full, 0.9 to 4.7 MB of live world.
    id: 'palworld-world',
    // As in the hub's catalogue. Components are `palworld` in the hub's plans
    // and `palworldpalworld` in the marketplace app.
    match: { name: 'palworld', repotag: 'palworld', component: '^palworld' },
    include: [
      // Each world: Level.sav, LevelMeta.sav, LocalData.sav, Players/,
      // WorldOption.sav and whatever else the owner put there (the hub's
      // `.pre-restore-*` undo copies), but not the game's restore points in
      // backup/, nor world_save_bak/ (the save before the last, as large as the
      // world), nor temporary files. A restore replaces those entries and leaves the node's restore
      // points alone. The stray SaveGames/0/backup some volumes have is a
      // restore point folder, not a world.
      {
        path: 'SaveGames/0',
        required: true,
        children: true,
        excludeChildren: /^backup$|\.sync-conflict-/,
        // Also what a save or a sync is writing, or gave up on: never part of
        // the world, and `validate` still sees it.
        excludeWithin: /^(backup|world_save_bak|world_save_temp)$|\.new_tmp$|^\.atomic_save_update_manifest|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/,
        // Plus the newest restore point at least ten minutes old: from the
        // ten-minute tier, so the game keeps it for the hour, and taken on the
        // primary as one whole save, so it is a committed world even if the
        // standby's live files above were caught between two saves.
        latestWithin: {
          path: 'backup/world', name: /^\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}$/, settledMs: 10 * 60 * 1000, directory: true,
        },
        validate: palworldWorldsCommitted,
      },
      // PalWorldSettings.ini (the admin password the hub reads, every world
      // rule) and GameUserSettings.ini (which world folder is loaded).
      { path: 'Config/LinuxServer' },
      // Anything else the owner put in Pal/Saved (seen: a Mods folder, a
      // UE4SS build, a world zip), which nothing else has a copy of. Left out
      // is what the game and the image write again by themselves: crash
      // reports, logs, ImGui, CrashReportClient and flux-guard.log.
      {
        path: '',
        children: true,
        excludeChildren: /^(SaveGames|Config|Crashes|ImGui|Logs|\.flux-backup)$|^flux-guard.*\.log$/,
      },
    ],
  },
];
