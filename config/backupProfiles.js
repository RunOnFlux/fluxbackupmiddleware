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
 *   splitWithin  with `excludeWithin`: the folders kept inside a child folder
 *                are archived as what they hold too, each entry on its own
 *                (less what `excludeWithin` matches), rather than whole. For a
 *                folder where the game renames a file every few seconds: tar
 *                reading the folder itself fails with "file changed as we read
 *                it", while each file in it is read whole
 *   latestWithin { path, name, settledMs, directory }: with `excludeWithin`,
 *                also archive the newest settled entry of `<child>/<path>`
 *                whose name matches, as `latest` does (a folder when
 *                `directory`), even though `path` itself is left out. With
 *                `path: ''` it is picked from the child folder itself, among
 *                the entries `excludeWithin` leaves out
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
 * `ignoreChanges` (a profile option, a RegExp): files of these names may change
 * while the archive is written without it being written again. Only for a
 * file the game replaces whole (written aside and renamed) every few seconds
 * whatever happens in the world, so the archive still holds one whole copy.
 *
 * `minSavedShare` (a profile option, 0 to 1): take the full backup when what
 * the profile leaves out is a smaller share of the volume than this. The full
 * backup pauses Syncthing while it archives and the profiled one does not, so
 * a profile that saves almost nothing is not worth a world caught changing.
 *
 * `primarySafe` (a profile option, true): when the secondaries fail, the last
 * attempt may take this profile's archive on the primary, with the server
 * running. Only for a game whose saves the listings see change: every file a
 * save writes sits in a folder that is listed (an entry, or a folder one level
 * inside a `children` entry), or the save is written aside and renamed, or the
 * profile also keeps a settled copy. A folder deeper than that is compared
 * only by its own time and total size, which a file rewritten in place at the
 * same size changes neither of (Minecraft's regions, Zomboid's map chunks), so
 * such a game would be archived half before and half after a save without
 * anything failing. `ignoreChanges` is no use there either: on the primary the
 * game writes the file in place, not whole.
 *
 * `restoreClear` (a profile option, [{ folder, name }]): what a restore of
 * this profile's archive removes besides the entries it replaces, in each
 * folder matching `folder` (relative to appdata, `*` for one path segment)
 * that the archive restores entries into: the files whose name matches `name`
 * and that the archive does not hold. For game state a split folder leaves
 * out that the game would load in place of the restored files (V Rising's
 * newer autosaves). The hub and the cloud UI read it from /getrestorerules.
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

/**
 * A Syncthing temporary file written to in the last ten minutes: a sync still
 * arriving. An older one is one a sync gave up on (Syncthing keeps those for a
 * day); it says nothing about the files around it.
 */
const SYNC_ARRIVING_MS = 10 * 60 * 1000;
function syncArriving(entries, now) {
  return entries.find((entry) => entry && SYNCTHING_TEMP.test(String(entry.name))
    && !(now - Date.parse(entry.modifiedAt) >= SYNC_ARRIVING_MS));
}

/**
 * Whether the top of a Minecraft volume holds a world, and no sync arriving in
 * it or in the folders listed under it.
 *
 * A Java world is a folder holding level.dat, under whatever name `level-name`
 * gives it (seen: world, season, Forever WOrld). A Bedrock one is a folder in
 * worlds/. Minecraft has no save that spans files, so there is nothing to
 * check across them: every region file arrives whole (Syncthing renames it
 * into place), and one that changes while the archive is written makes tar
 * fail, which takes the full backup.
 */
function minecraftWorldPresent(isWorld) {
  return (listing, now = Date.now()) => {
    const nested = listing.flatMap((item) => (Array.isArray(item.children) ? item.children : []));
    const arriving = syncArriving([...listing, ...nested], now);
    if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
    return listing.some(isWorld) ? null : 'no world';
  };
}
const javaWorld = (item) => item.isDirectory && (item.children || [])
  .some((file) => file.isFile && file.name === 'level.dat' && Number(file.size) > 0);
const bedrockWorlds = (item) => item.isDirectory && item.name === 'worlds' && (item.children || [])
  .some((world) => world.isDirectory && Number(world.size) > 0);

/**
 * A file ARK: Survival Ascended writes on every save: a byte copy of the world
 * as that save left it, `<MAP>_DD.MM.YYYY_HH.MM.SS.arkrbf` (the time in the
 * server's timezone). The game keeps the newest four and deletes the rest.
 */
const ARK_ROLLBACK = /\.arkrbf$/i;
/**
 * The world copy ARK: Survival Ascended also leaves every nine saves (two hours
 * and a quarter), `<MAP>_DD.MM.YYYY_HH.MM.SS.ark`, which it does not delete:
 * 21 of them on a test server two days after a restart (2026-10-18).
 */
const ARK_DATED_COPY = /_\d{2}\.\d{2}\.\d{4}_\d{2}\.\d{2}\.\d{2}\.ark$/i;

/**
 * Whether SavedArks holds an ARK: Survival Ascended world, and no sync
 * arriving in it.
 *
 * A world is a map folder (TheIsland_WP, ScorchedEarth_WP, ...) holding a
 * non-empty `<MAP>.ark`, a SQLite file the game writes in place, beside a
 * `.arkprofile` per player and a `.arktribe` per tribe. Those are saved with
 * the world, and also each on its own as players come and go, so there is no
 * single save to check them against. What a sync can still have half-way is a
 * file Syncthing is writing under a temporary name; one written to in the last
 * ten minutes is a sync still arriving. The newest `.arkrbf` archived beside
 * the world is the whole save the game wrote at once, kept for the case the
 * standby's `.ark` was copied while the primary was writing it.
 */
function arkWorldPresent(listing, now = Date.now()) {
  const inside = listing.flatMap((item) => [...(item.children || []), ...(item.excludedChildren || [])]);
  const arriving = syncArriving([...listing, ...inside], now);
  if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
  const world = listing.some((item) => item.isDirectory && (item.children || [])
    .some((file) => file.isFile && /\.ark$/i.test(String(file.name)) && !ARK_DATED_COPY.test(String(file.name))
      && Number(file.size) > 0));
  return world ? null : 'no world';
}

/**
 * Whether Saves/Multiplayer holds a Project Zomboid world, and no sync
 * arriving in it.
 *
 * A world is a folder named after the server (SERVERNAME, `projectzomboid` on
 * the hub) holding a non-empty `players.db`, written when the world is made,
 * beside `vehicles.db` and the map in `map/` and `chunkdata/`. The game writes
 * chunks as they unload rather than in one save, so there is no generation to
 * check them against; what a sync can still have half-way is a file Syncthing
 * is writing under a temporary name.
 */
function zomboidWorldPresent(listing, now = Date.now()) {
  const inside = listing.flatMap((item) => (Array.isArray(item.children) ? item.children : []));
  const arriving = syncArriving([...listing, ...inside], now);
  if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
  const world = listing.some((item) => item.isDirectory && (item.children || [])
    .some((file) => file.isFile && file.name === 'players.db' && Number(file.size) > 0));
  return world ? null : 'no world';
}

/**
 * Whether `saved` holds a Satisfactory world, and no sync arriving in it.
 *
 * The saves are `.sav` files in saved/server, each a whole session the game
 * writes at once (autosaves rotate through `<session>_autosave_N.sav`). Beside
 * `server` is `ServerSettings.<port>.sav`: the server's name, admin password
 * and options. A server nobody has created a session on has no save, and gets
 * the full backup.
 */
function satisfactoryWorldPresent(listing, now = Date.now()) {
  const inside = listing.flatMap((item) => (Array.isArray(item.children) ? item.children : []));
  const arriving = syncArriving([...listing, ...inside], now);
  if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
  const world = listing.some((item) => item.isDirectory && item.name === 'server' && (item.children || [])
    .some((file) => file.isFile && /\.sav$/i.test(String(file.name)) && Number(file.size) > 0));
  return world ? null : 'no world';
}

/**
 * Whether the top of a Rust server identity holds a world, and no sync
 * arriving in it.
 *
 * The world is `proceduralmap.<size>.<seed>.<version>.sav` (or the custom
 * map's name), which the server writes as `.sav.new` and renames, after
 * moving the previous ones to `.sav.1` and `.sav.2`. Beside it are the SQLite
 * databases of players, blueprints, clans and signs, each with its `-wal`.
 * A server still generating its first map has no save yet, and the full
 * backup of a volume that is a whole install (littlestache/rust-server) has
 * none at its top either.
 */
function rustWorldPresent(listing, now = Date.now()) {
  const arriving = syncArriving([...listing, ...(listing.leftOut || [])], now);
  if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
  const world = listing.some((item) => item.isFile && /\.sav$/i.test(String(item.name)) && Number(item.size) > 0);
  return world ? null : 'no world';
}

/**
 * Whether the top of a TShock config directory holds a world, and no sync
 * arriving in it.
 *
 * The world is `<name>.wld` (FluxWorld.wld unless the owner renamed it or
 * uploaded another beside it). Terraria writes it whole on every save after
 * moving the previous one to `.wld.bak`, and that one to `.wld.bak2`. A volume
 * whose image keeps its worlds elsewhere (beardedio's /config, littlestache)
 * has none at its top.
 */
function terrariaWorldPresent(listing, now = Date.now()) {
  const arriving = syncArriving([...listing, ...(listing.leftOut || [])], now);
  if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
  const world = listing.some((item) => item.isFile && /\.wld$/i.test(String(item.name)) && Number(item.size) > 0);
  return world ? null : 'no world';
}

/**
 * Whether universe/ holds a Hytale world, and no sync arriving at its top.
 *
 * A world is a folder in universe/worlds (`default` unless the owner made
 * others) with its region files in chunks/ and its config.json; players/ and
 * resources/ sit beside worlds/. A server whose owner never approved the
 * downloader's code has no universe at all, so its volume keeps the full
 * backup.
 */
function hytaleWorldPresent(listing, now = Date.now()) {
  const inside = listing.flatMap((item) => (Array.isArray(item.children) ? item.children : []));
  const arriving = syncArriving([...listing, ...inside], now);
  if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
  const world = listing.some((item) => item.isDirectory && item.name === 'worlds' && (item.children || [])
    .some((folder) => folder.isDirectory && Number(folder.size) > 0));
  return world ? null : 'no world';
}

/** A V Rising autosave: the whole world, `AutoSave_<n>.save.gz` (`.save` before 1.0). */
const VRISING_AUTOSAVE = /^AutoSave_\d+\.save(\.gz)?$/i;

/** How old the newest V Rising autosave must be to be taken (one comes every 2 minutes). */
const VRISING_SETTLED_MS = 3 * 60 * 1000;

/**
 * Whether Saves/v4 holds a V Rising world whose newest autosave has settled,
 * and no sync arriving in it.
 *
 * A world is a folder named after VR_SAVE_NAME (`world1` on the hub) holding
 * AutoSave_<n>.save.gz files, each the whole world, beside SessionId.json and
 * StartDate.json. The game writes a save into .TEMP and moves it in, and keeps
 * the last 20 (AutoSaveCount). Only the newest settled one is archived, so a
 * world whose saves are all younger than VRISING_SETTLED_MS (a server that has
 * only just made it) is not ready yet.
 */
function vrisingWorldPresent(listing, now = Date.now()) {
  const inside = listing.flatMap((item) => [...(item.children || []), ...(item.excludedChildren || [])]);
  const arriving = syncArriving([...listing, ...inside], now);
  if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
  const saves = (item) => (item.excludedChildren || [])
    .filter((file) => file.isFile && VRISING_AUTOSAVE.test(String(file.name)) && Number(file.size) > 0);
  const worlds = listing.filter((item) => item.isDirectory && saves(item).length > 0);
  if (worlds.length === 0) return 'no world';
  const young = worlds.find((item) => !saves(item).some((file) => now - Date.parse(file.modifiedAt) >= VRISING_SETTLED_MS));
  if (young) return { reason: `${young.name} has no settled autosave yet`, unsettled: true };
  return null;
}

/**
 * Whether Saves holds a 7 Days to Die world, and no sync arriving in it.
 *
 * A world is Saves/<world>/<game> (GameWorld and GameName, `MyGame` unless the
 * owner renamed it) holding main.ttw, beside Region/, Player/ and the .dat
 * files. The game writes them as it plays, a region at a time, so there is no
 * generation to check them against; what a sync can still have half-way is a
 * file Syncthing is writing under a temporary name.
 */
function sdtdWorldPresent(listing, now = Date.now()) {
  const games = listing.flatMap((item) => (Array.isArray(item.children) ? item.children : []));
  const inside = games.flatMap((item) => (Array.isArray(item.children) ? item.children : []));
  const arriving = syncArriving([...listing, ...games, ...inside], now);
  if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
  const world = games.some((game) => game.isDirectory && (game.children || [])
    .some((file) => file.isFile && file.name === 'main.ttw' && Number(file.size) > 0));
  return world ? null : 'no world';
}

/**
 * What DepotDownloader puts at the top of a Windrose volume (app 4129620, the
 * Windows server), beside R5.
 */
const WINDROSE_INSTALL = new RegExp([
  '^(R5|Engine|linux64|\\.DepotDownloader|Manifest_\\w+\\.txt',
  'steamclient(64)?\\.(so|dll)|steamwebrtc(64)?\\.dll|libsteamwebrtc\\.so|tier0_s(64)?\\.dll|vstdlib_s(64)?\\.dll',
  'WindroseServer\\.exe|R5WorldDescriptionUpdater\\.exe|DedicatedServer\\.md|SaveWorkflow\\.md|StartServerForeground\\.bat)$',
].join('|'), 'i');

/**
 * Whether R5/Saved/SaveProfiles holds a Windrose world, and no sync arriving
 * in it.
 *
 * A save profile (`Default`) holds RocksDB_v2, the live database of every
 * world, and RocksDB_v2_Backups, the game's own copies of it. RocksDB writes
 * the database in place, so the copies are archived with it: they are what is
 * left if a standby's copy of the live one was caught half-synced.
 */
function windroseWorldPresent(listing, now = Date.now()) {
  const inside = listing.flatMap((item) => (Array.isArray(item.children) ? item.children : []));
  const arriving = syncArriving([...listing, ...inside], now);
  if (arriving) return { reason: `${arriving.name} is still being synced`, unsettled: true };
  const world = inside.some((item) => item.isDirectory && item.name === 'RocksDB_v2' && Number(item.size) > 0);
  return world ? null : 'no world';
}

/**
 * What the itzg Java image puts at the top of /data by itself, from TYPE,
 * VERSION and the loader variables, and fetches again on a node that lacks it:
 * the server jar and its launcher, the libraries and game versions it runs on,
 * download caches, and the files that record what is installed. Those records
 * go with the install they describe: restored over a node that installed
 * something else, a `.forge-manifest.json` would tell the image the wrong build
 * is already there. Measured on 90 nodes (2026-10-14): 26 GB of 184.
 */
const MINECRAFT_JAVA_INSTALL = new RegExp([
  '^(libraries|versions|\\.fabric|cache|\\.cache|logs|crash-reports|debug|\\.flux-backup)$',
  // .forge-manifest.json, .papermc-manifest.json, .install-fabric.env, .run-forge.env, .paper.env
  // ... and Syncthing's conflict copies of them, as old as the install they describe
  '^\\.([\\w-]+-manifest(\\.sync-conflict-[\\w-]+)?\\.json|install-[\\w-]+\\.env|run-[\\w-]+\\.env|paper\\.env|purpur\\.env)$',
  // The RCON password file is written again on every start, conflict copies included.
  '^(run\\.sh|run\\.bat|user_jvm_args\\.txt)$|^\\.rcon-cli\\.',
  // Mixin's debug dump of the classes it transformed.
  '^\\.mixin\\.out$',
  '^hs_err_pid\\d+\\.log$',
  '^minecraft_server\\.[\\d.]+\\.jar(\\.download)?$',
  '^(paper|purpur|folia)-[\\d.]+-\\d+\\.jar(\\.download)?$',
  '^fabric-server-mc\\.[\\d.]+-loader\\.[\\d.]+-launcher\\.[\\d.]+\\.jar$',
  '^(neo)?forge-[\\d.]+(-[\\d.]+)?-(shim|installer)\\.jar(\\.log)?$',
].join('|'));

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
    // The .sav files sit in the listed SaveGames folder.
    primarySafe: true,
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
    // A save writes a new generation of files, listed in the world folder,
    // and the newest settled hourly zip goes in too.
    primarySafe: true,
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
    // The world's files and Players/ are listed, saves are written aside and
    // renamed, and a settled restore point goes in too.
    primarySafe: true,
    // A WorldOption.sav the archive does not hold (one uploaded after the
    // backup) would override PalWorldSettings.ini over the restored world.
    restoreClear: [{ folder: 'SaveGames/0/*', name: /^WorldOption\.sav$/ }],
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
  {
    // ARK: Survival Ascended on acekorneya/asa_server (POK). appdata is
    // ShooterGame/Saved; the server and the mods it downloads are on local
    // (ml:) mounts. What makes the full backup large is the world over and
    // over: every save leaves a `.arkrbf` copy of the `.ark` (the game keeps
    // 4), every ninth a dated `.ark` copy it never deletes, and there is an
    // AntiCorruptionBackup.bak copy as well. On a test server two days after a
    // restart that was 26 worlds, 1.69 GB, against 130 MB archived here.
    id: 'ark-ascended-world',
    // As in the hub's catalogue.
    match: { name: 'arksurvivalascended', repotag: 'asa_server', component: '^arksurvivalascended' },
    // The map folder's files are listed, and a settled .arkrbf goes in too.
    primarySafe: true,
    include: [
      // Each map folder: the world, every player's .arkprofile and tribe's
      // .arktribe and whatever else is there, but not the game's own copies,
      // plus the newest of those copies that has settled. On restore the game
      // loads the .ark; the copies already on the node are left alone and are
      // not loaded in its place.
      {
        path: 'SavedArks',
        required: true,
        children: true,
        excludeChildren: /\.sync-conflict-/,
        excludeWithin: /\.arkrbf$|_\d{2}\.\d{2}\.\d{4}_\d{2}\.\d{2}\.\d{2}\.ark$|_AntiCorruptionBackup\.bak$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
        latestWithin: { path: '', name: ARK_ROLLBACK, settledMs: 5 * 60 * 1000 },
        validate: arkWorldPresent,
      },
      // Config/WindowsServer (GameUserSettings.ini, Game.ini) and anything else
      // the owner keeps in Saved (cluster transfers, a copied save). Left out
      // is what the game and the image write again by themselves.
      {
        path: '',
        children: true,
        excludeChildren: /^(SavedArks|Logs|Crashes|webcache.*|\.flux-backup)$/i,
      },
    ],
  },
  {
    // ARK: Survival Evolved on runonflux/ase-server-flux. appdata is /mnt/ase/data:
    // Saved (the game's Saved folder, which the install links to) and flux, the
    // image's state. The 23 GB install, the mods it unpacks and the logs are on
    // local (ml:) mounts. What makes the full backup large is the world over
    // and over: ARK writes a dated `<MAP>_DD.MM.YYYY_HH.MM.SS.ark` copy of the
    // whole world every few saves and never deletes it (the image keeps the
    // newest 4), a `.bak` beside each world, and the image makes its own
    // tar.gz of Saved on every start and every few hours (flux/backups).
    id: 'ark-evolved-world',
    // As in the hub's catalogue. Not the Ascended profile's: that match is
    // `arksurvivalascended`, and this layout has Saved/ under the data volume.
    match: { name: '^arksurvivalevolved', repotag: '(^|/)ase-server-flux', component: '^arksurvivalevolved' },
    include: [
      // Each map folder: the world, every player's .arkprofile and tribe's
      // .arktribe and whatever else is there, but not the dated copies, the
      // .bak files or the image's one-off .flux-premigration, plus the newest
      // dated copy that has settled, whole, as a restore point. The `.ark`
      // the game loads is the one that is restored; the copies already on the
      // node are left alone and are not loaded in its place.
      {
        path: 'Saved/SavedArks',
        required: true,
        children: true,
        excludeChildren: /\.sync-conflict-|^\.flux-premigration$/,
        excludeWithin: /_\d{2}\.\d{2}\.\d{4}_\d{2}\.\d{2}\.\d{2}\.ark$|\.bak$|\.tmp$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
        latestWithin: { path: '', name: ARK_DATED_COPY, settledMs: 5 * 60 * 1000 },
        validate: arkWorldPresent,
      },
      // Saved/Config/LinuxServer (GameUserSettings.ini, Game.ini: the mod list
      // is ActiveMods in it) and whatever else the owner keeps in Saved. Left
      // out is what the game and the image write again by themselves.
      {
        path: 'Saved',
        children: true,
        excludeChildren: /^(SavedArks|Logs|Crashes|webcache.*)$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
      },
      // The image's state: mods.json (the panel's mod list), state, the admin
      // secret. Not its backups (the same world again), and not a restore or
      // an update it was asked for: restore-pending would restore from
      // flux/backups, which a node restored from this archive does not have.
      {
        path: 'flux',
        children: true,
        excludeChildren: /^(backups|tmp|restore-pending|update-.*\.json)$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
      },
      {
        path: '',
        children: true,
        excludeChildren: /^(Saved|flux|\.flux-backup)$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
      },
    ],
  },
  {
    // Project Zomboid (Build 41 and 42) on danixu86/project-zomboid-dedicated-server.
    // appdata is the game's Zomboid folder; the server is in the image and the
    // Workshop mods on a local (ml:) mount. What makes the full backup large is
    // the game's own backups: on every start it zips the whole world, with the
    // server's settings and accounts, into backups/startup (5 kept), and once
    // more into backups/version when the game updates. Its old logs are moved
    // into Logs/logs_<date> and never deleted. On a server a week old
    // (2026-10-18) that was 4.47 GB of backups and 146 MB of logs beside an
    // 839 MB world.
    id: 'zomboid-world',
    // As in the hub's catalogue.
    match: { name: 'zomboid', repotag: 'zomboid', component: '^projectzomboid' },
    include: [
      // Each world, whole: the map, players.db and vehicles.db.
      {
        path: 'Saves/Multiplayer',
        required: true,
        children: true,
        excludeChildren: /\.sync-conflict-/,
        validate: zomboidWorldPresent,
      },
      // Server (the .ini, SandboxVars, spawn regions), db (accounts, admins,
      // bans, whitelist), Lua, mods and anything else the owner keeps there.
      // Left out are the game's backups and logs, and Saves, archived above.
      {
        path: '',
        children: true,
        excludeChildren: /^(Saves|backups|Logs|server-console\.txt|\.flux-backup)$/i,
      },
    ],
  },
  {
    // Rust on pfeiffermax/rust-game-server (vanilla) and our
    // runonflux/rust-carbon-server. appdata is the server identity,
    // /srv/rust/server/<identity>; the server is in the image and Carbon's
    // plugins on their own (m:) mount. What makes the full backup large is
    // what the server works out from the map again: the AI's navmesh (160 to
    // 233 MB on the network, 2026-10-18, and one more per game version since
    // the last wipe) and the occlusion cache, beside a world of about 7 MB
    // and the two saves before it.
    id: 'rust-world',
    // As in the hub's catalogue.
    match: { name: 'rust', repotag: 'rust|carbon|oxide', component: '^rust' },
    // The world, the map and the databases sit at the listed top.
    primarySafe: true,
    include: [
      // The world, the procedural or custom map it is on (generating it again
      // takes up to half an hour, and a custom map's URL may be gone), the
      // databases with their -wal, cfg/ (server.cfg, users.cfg, bans.cfg) and
      // whatever else the owner keeps there.
      {
        path: '',
        children: true,
        excludeChildren: /\.navmesh$|_occlusion_\d+\.dat$|\.sav\.(\d+|new)$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$|^\.flux-backup$/i,
        validate: rustWorldPresent,
      },
    ],
  },
  {
    // Terraria on TShock: the official ghcr.io/pryaxis/tshock and the older
    // ryshe/terraria both mount the TShock config directory as appdata, with
    // the world, config.json and tshock.sqlite at its top. The weight is
    // TShock's own rolling backup, a whole copy of the world every 10 minutes
    // kept for 4 hours (13 copies of a 12 MB world, 159 MB, in backups/ on
    // the network, 2026-10-18), and the copies stay there for good once the
    // server stops.
    id: 'terraria-world',
    // As in the hub's catalogue.
    match: { name: 'terraria', repotag: 'terraria|tshock', component: '^terraria' },
    // The worlds and tshock.sqlite sit at the listed top.
    primarySafe: true,
    include: [
      // Every world, the save before the last (.wld.bak), the TShock config,
      // its accounts and regions, and whatever else the owner keeps there.
      {
        path: '',
        children: true,
        excludeChildren: /^(backups|logs|crashes|tshock\.pid|\.flux-backup)$|\.wld\.bak2$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
        validate: terrariaWorldPresent,
      },
    ],
  },
  {
    // Hytale on indifferentbroccoli/hytale-server-docker. appdata is
    // server-files, and almost all of it is the game: Assets.zip (3.5 to
    // 3.9 GB) and Server/ (230 MB) beside a world of up to about 100 MB, plus
    // the server's own hourly zips of the whole universe in backups/ (860 MB
    // on one app on the network, 2026-10-18).
    //
    // The image downloads the game again when Server/HytaleServer.jar is
    // missing, with the downloader's credentials in downloader/. Those are
    // left out too: Hytale's refresh tokens are single-use, so the ones in a
    // backup were spent by the live server long before a restore, and with a
    // spent token and no game the image exits on every start without asking
    // for a code. Without them a restore starts like a new server: the owner
    // approves the downloader's code (the hub's Account tab shows it), the
    // game downloads, and the world loads.
    id: 'hytale-world',
    // As in the hub's catalogue.
    match: { name: 'hytale', repotag: 'hytale-server', component: '^hytale' },
    include: [
      // The worlds, the players and the universe's resources.
      {
        path: 'universe',
        required: true,
        children: true,
        excludeChildren: /\.sync-conflict-/,
        validate: hytaleWorldPresent,
      },
      // config.json, permissions, bans, whitelist, mods/ and earlyplugins/,
      // the server's own account (auth.enc, readable only with .machine-id)
      // and whatever else the owner keeps there.
      {
        path: '',
        children: true,
        excludeChildren: /^(universe|Assets\.zip|Server|downloader|\.cache|backups|logs|telemetry|start\.(sh|bat)|\.server-version|game\.zip|hytale-downloader\.zip|\.flux-backup)$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
      },
    ],
  },
  {
    // V Rising on runonflux/vrising-server-flux. appdata is persistentdata
    // (the install and the mods are m: mounts, outside the backup): Settings,
    // the logs and Saves/v4/<world>. The weight is the game's own 20 autosaves
    // per world, each the whole world (8 to 12 MB, 140 to 225 MB per app on
    // the network, 2026-10-18).
    id: 'vrising-world',
    // As in the hub's catalogue.
    match: { name: 'vrising', repotag: 'vrising', component: '^vrising' },
    // Each autosave is a new file, and only a settled one goes in.
    primarySafe: true,
    // The archive holds one autosave per world, loose; the newer ones on the
    // node would be loaded in its place, so the restore would change nothing.
    restoreClear: [{ folder: 'Saves/v4/*', name: VRISING_AUTOSAVE }],
    include: [
      // Each world folder: SessionId.json, StartDate.json and whatever else is
      // there, plus its newest settled autosave, which is what the server
      // loads when it is the only one.
      {
        path: 'Saves/v4',
        required: true,
        children: true,
        excludeChildren: /\.sync-conflict-/,
        excludeWithin: /^AutoSave_\d+\.save(\.gz)?$|^\.TEMP$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
        latestWithin: { path: '', name: VRISING_AUTOSAVE, settledMs: VRISING_SETTLED_MS },
        validate: vrisingWorldPresent,
      },
      // Settings (ServerHostSettings.json, ServerGameSettings.json, the admin
      // and ban lists), the hub's flux/ and whatever else the owner keeps
      // there, but not the game's logs.
      {
        path: '',
        children: true,
        excludeChildren: /^(Saves|\.flux-backup)$|-VRisingServer\.log$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
      },
    ],
  },
  {
    // 7 Days to Die on runonflux/7dtd-server-flux. appdata is /mnt/7dtd/data
    // (the install is an ml: mount, the mods an m: one): serverconfig.xml,
    // Saves, GeneratedWorlds, the image's own backups and the logs. The
    // weight is backups/, a world.tar.gz of Saves and GeneratedWorlds taken
    // before every start, several kept (1.08 GB beside a 420 MB world on one
    // app on the network, 2026-10-18).
    id: '7dtd-world',
    // As in the hub's catalogue.
    match: { name: '7daystodie', repotag: '7dtd-server', component: '^7daystodie' },
    // The game writes main.ttw (the world's clock and counters) every 30
    // seconds even with nobody on, moving the previous one to main.ttw.bak,
    // which no archive of a few hundred MB would ever get past. The regions,
    // players and the rest change only when someone plays.
    ignoreChanges: /^main\.ttw(\.bak)?$/,
    include: [
      // Each world's save folders, entry by entry, and the files beside them
      // (serveradmin.xml, sdcs_profiles.sdf).
      {
        path: 'Saves',
        required: true,
        children: true,
        excludeChildren: /\.sync-conflict-/,
        excludeWithin: /\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
        // The game folder is where main.ttw is renamed every 30 seconds.
        splitWithin: true,
        validate: sdtdWorldPresent,
      },
      // The newest of the image's backups: taken with nothing running, it is
      // the one copy of the world that is consistent for certain, and the
      // hub's Rollback restores from it.
      { path: 'backups', latest: { name: /^\d{8}-\d{6}-world\.tar\.gz$/, settledMs: 2 * 60 * 1000 } },
      // serverconfig.xml, GeneratedWorlds (a random world takes a long time
      // to generate again, and only from the same seed and version), the
      // hub's flux/ and whatever else the owner keeps there.
      {
        path: '',
        children: true,
        excludeChildren: /^(Saves|backups|logs|\.flux-backup)$|\.sync-conflict-|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/i,
      },
    ],
  },
  {
    // Windrose on indifferentbroccoli/windrose-server-docker. appdata is
    // server-files, the whole Windows install that DepotDownloader fetches
    // again (anonymously) on every start with UPDATE_ON_START, as the hub
    // deploys it: 3.3 GB, almost all of it R5/Content, beside a world of a
    // few to 25 MB (2026-10-18). Windrose+ (WINDROSE_PLUS_ENABLED) unpacks
    // its release into the top and into R5/Binaries and R5/Content/Paks, and
    // installs itself again when .windroseplus_version is missing.
    id: 'windrose-world',
    // As in the hub's catalogue.
    match: { name: 'windrose', repotag: 'windrose', component: '^windrose' },
    include: [
      // The worlds and the game's own copies of them.
      {
        path: 'R5/Saved/SaveProfiles',
        required: true,
        children: true,
        excludeChildren: /\.sync-conflict-/,
        validate: windroseWorldPresent,
      },
      // The server's identity, invite code and world choice.
      { path: 'R5/ServerDescription.json', file: true },
      { path: 'R5/Saved/Config' },
      // Windrose+'s config, data and the owner's mods, and whatever else the
      // owner keeps there; not the game's own files at the top, nor
      // Windrose+'s version marker, so that it installs itself again into the
      // R5 the image downloads.
      {
        path: '',
        children: true,
        excludeChildren: new RegExp(`${WINDROSE_INSTALL.source}|^(\\.windroseplus_version|\\.flux-backup)$|\\.sync-conflict-|^\\.syncthing\\..*\\.tmp$|^~syncthing~.*\\.tmp$`, 'i'),
      },
    ],
  },
  {
    // Satisfactory on wolveix/satisfactory-server. appdata is /config, and
    // almost all of it is the server's install in gamefiles (2.9 to 4.3 GB on
    // the network's 14 apps, 2026-10-18) beside saves of a few MB. The image
    // installs the server again on start when FactoryServer.sh is missing, even
    // with SKIPUPDATE, so a restore onto an empty volume still starts.
    id: 'satisfactory-world',
    // As in the hub's catalogue.
    match: { name: 'satisfactory', repotag: 'satisfactory-server', component: '^satisfactory' },
    // The saves sit in saved/server, listed one level inside saved, and each
    // autosave is a new file.
    primarySafe: true,
    include: [
      // server/ (the sessions' saves), blueprints/ and ServerSettings.<port>.sav.
      {
        path: 'saved',
        required: true,
        children: true,
        excludeChildren: /\.sync-conflict-/,
        validate: satisfactoryWorldPresent,
      },
      // Inside the install, but not downloaded again: the server's ini files,
      // the ficsit.app mods the owner installed (with SML) and their settings.
      { path: 'gamefiles/FactoryGame/Saved/Config' },
      { path: 'gamefiles/FactoryGame/Mods' },
      { path: 'gamefiles/FactoryGame/Configs' },
      // The hub's flux/ folder and anything else the owner keeps there. Left
      // out are the install, the copy of saved/server the image makes in
      // backups/ on every start, and Steam's logs.
      {
        path: '',
        children: true,
        excludeChildren: /^(gamefiles|saved|backups|logs|\.flux-backup)$/i,
      },
    ],
  },
  {
    // Minecraft Bedrock on itzg/minecraft-bedrock-server. First, because the
    // Java profile's match would take it too. appdata is /data: the server
    // as Mojang ships it, unzipped, beside the worlds and packs. The image
    // downloads the server again when bedrock_server-<VERSION> is missing, and
    // backup-pre-<version>/ is its own copy of the packs from before an
    // upgrade (two kept; never the worlds). Everything else is kept: the
    // behavior and resource packs mix Mojang's with the owner's.
    id: 'minecraft-bedrock-world',
    match: { name: 'bedrock', repotag: 'minecraft-bedrock', component: '^minecraftbedrock' },
    include: [
      {
        path: '',
        required: true,
        children: true,
        excludeChildren: /^(bedrock_server-[\d.]+|backup-pre-[\d.]+|\.flux-backup)$/,
        validate: minecraftWorldPresent(bedrockWorlds),
      },
    ],
  },
  {
    // Minecraft Java on itzg/minecraft-server, any TYPE. appdata is /data, so
    // the volume is the server's whole working directory. Unlike the other
    // games here most of a backup is the world itself (a 35 GB one has been
    // seen), and that is all kept; what goes is what the image installs again
    // (MINECRAFT_JAVA_INSTALL): 55% of the median server, 14% of the fleet.
    // Mods, plugins and config are kept whole, the owner's or a modpack's.
    id: 'minecraft-java-world',
    // A server with a large world saves next to nothing (0.6% of a 40 GB
    // one); 18 of 90 nodes saved under 10%, together 3 GB of their 139 GB.
    // Those keep the full backup, which pauses Syncthing while it archives:
    // a big world on a busy server would otherwise be read while regions keep
    // arriving, fail, be written again, and end in the full backup anyway.
    minSavedShare: 0.1,
    // As in the hub's catalogue. Components are `minecraft`, `minecraftserver`
    // and `Minecraft` (doubled in the marketplace's).
    match: { name: 'minecraft', repotag: 'minecraft-server', component: '^minecraft' },
    include: [
      {
        path: '',
        required: true,
        children: true,
        excludeChildren: MINECRAFT_JAVA_INSTALL,
        validate: minecraftWorldPresent(javaWorld),
      },
    ],
  },
];
