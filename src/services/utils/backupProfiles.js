const defaultProfiles = require('../../../config/backupProfiles');

/**
 * Empty directory created at the root of appdata and archived with a profile's
 * paths. Archiving it makes appdata the archive's common parent, so members keep
 * their appdata-relative names (RSDragonwilds/Saved/...), exactly as in a full
 * backup. Without it the root would move down to the deepest folder the listed
 * paths share. Its presence also marks an archive as partial.
 */
const PROFILE_MARKER_DIR = '.flux-backup';

const pattern = (source) => (source ? new RegExp(source, 'i') : null);

/**
 * Whether a profile's `match` names this component. The games hub's rule
 * (catalog.js appMatchesEntry), applied to one component rather than to the
 * whole app: any one criterion is enough, and the app's name counts only when
 * the app has no other component it could mean.
 *
 * @param {object} match - { name, component, repotag }, regular expression sources
 * @param {object} target
 * @param {string} target.appname
 * @param {string} target.component
 * @param {string|null} target.repotag - null when it is not known
 * @param {number} target.componentCount - how many components the app has
 */
function matchesComponent(match, {
  appname, component, repotag, componentCount,
}) {
  const m = match || {};
  const byComponent = pattern(m.component);
  const byImage = pattern(m.repotag);
  const byName = pattern(m.name);
  if (byComponent && byComponent.test(String(component || ''))) return true;
  if (byImage && repotag && byImage.test(String(repotag))) return true;
  return Boolean(byName && componentCount === 1 && byName.test(String(appname || '')));
}

function profileForComponent(target, profiles = defaultProfiles) {
  return profiles.find((profile) => matchesComponent(profile.match, target)) || null;
}

/**
 * The profile for every component, or null when any component has none.
 *
 * All or nothing because a node backs up a whole app in one stop: mixing a
 * profiled archive with appendbackuptask would stop the app for the full
 * archive anyway and save nothing.
 *
 * @param {string} appname
 * @param {string[]} componentNames - the components being backed up
 * @param {object} [known]
 * @param {Object<string, string>} [known.repotags] - component name -> repotag, where known
 * @param {number} [known.componentCount] - how many components the app has, when
 *   known; otherwise the components being backed up are taken to be all of them
 * @returns {Object<string, object>|null} component name -> profile
 */
function resolveComponentProfiles(appname, componentNames, known = {}, profiles = defaultProfiles) {
  if (!Array.isArray(componentNames) || componentNames.length === 0) return null;
  const repotags = known.repotags || {};
  const componentCount = known.componentCount || componentNames.length;
  const result = {};
  for (let i = 0; i < componentNames.length; i += 1) {
    const profile = profileForComponent({
      appname,
      component: componentNames[i],
      repotag: repotags[componentNames[i]] || null,
      componentCount,
    }, profiles);
    if (!profile) return null;
    result[componentNames[i]] = profile;
  }
  return result;
}

/**
 * The most folders of one `children` entry that are listed one level deeper.
 * A world folder is one per world, so a handful is normal; past this the
 * entry is not checked and the full backup is taken instead.
 */
const MAX_CHILD_FOLDERS = 20;

const parentOf = (entryPath) => {
  const slash = entryPath.lastIndexOf('/');
  return slash === -1 ? '' : entryPath.slice(0, slash);
};
const baseName = (entryPath) => entryPath.slice(entryPath.lastIndexOf('/') + 1);

/**
 * List what the node holds for each of a profile's entries.
 *
 * @param {object} profile
 * @param {function(string): Promise<Array|null>} list - lists a folder relative
 *   to appdata ('' for appdata itself): its getfolderinfo entries, or null when
 *   it does not exist; throws when the node cannot answer
 * @returns {Promise<Object<string, Array|object|null>>} entry path -> its listing
 *   (an array), or for a `file` entry its own getfolderinfo entry; null when
 *   missing. A `children` entry's folders carry their own listing as `children`
 *   (undefined past MAX_CHILD_FOLDERS)
 */
async function collectProfileListings(profile, list) {
  const listed = new Map();
  const listOnce = (folder) => {
    if (!listed.has(folder)) listed.set(folder, list(folder));
    return listed.get(folder);
  };
  const listings = {};
  for (let i = 0; i < profile.include.length; i += 1) {
    const entry = profile.include[i];
    // One at a time, on purpose: each is a request to a node that is serving
    // its own app, and they are a handful.
    if (entry.file) {
      // eslint-disable-next-line no-await-in-loop
      const siblings = await listOnce(parentOf(entry.path));
      listings[entry.path] = (siblings || [])
        .find((item) => item && item.isFile && item.name === baseName(entry.path)) || null;
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    let listing = await listOnce(entry.path);
    if (Array.isArray(listing) && entry.children) {
      const kept = listing.filter((item) => item && !(entry.excludeChildren && entry.excludeChildren.test(String(item.name))));
      let folders = 0;
      listing = [];
      for (let j = 0; j < kept.length; j += 1) {
        const item = kept[j];
        if (item.isDirectory && folders < MAX_CHILD_FOLDERS) {
          folders += 1;
          // eslint-disable-next-line no-await-in-loop
          listing.push({ ...item, children: (await listOnce(`${entry.path}/${item.name}`)) || [] });
        } else {
          listing.push(item);
        }
      }
    }
    listings[entry.path] = listing;
  }
  return listings;
}

/**
 * The newest non-empty file of a listing whose name matches, leaving out one
 * modified within `settledMs`: a file that is still being written.
 */
function newestSettledFile(listing, { name, settledMs = 0 }, now) {
  const time = (item) => {
    const parsed = Date.parse(item.modifiedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return listing
    .filter((item) => item && item.isFile && Number(item.size) > 0 && name.test(String(item.name)))
    .filter((item) => !settledMs || now - time(item) >= settledMs)
    .sort((a, b) => (time(b) - time(a)) || String(b.name).localeCompare(String(a.name)))[0] || null;
}

/**
 * Decide what to archive from the node's listings of the profile's paths.
 *
 * @param {object} profile
 * @param {Object<string, Array|object|null>} listings - from collectProfileListings
 * @param {number} [now] - the time `latest` measures settledMs from
 * @returns {{fits: true, sources: string[]} | {fits: false, reason: string, unsettled?: true}}
 *   sources are relative to the VOLUME root, as compressobject takes them;
 *   unsettled when an entry's `validate` found its files still arriving
 */
function planProfiledArchive(profile, listings, now = Date.now()) {
  const sources = [`appdata/${PROFILE_MARKER_DIR}`];
  for (let i = 0; i < profile.include.length; i += 1) {
    const entry = profile.include[i];
    const listing = listings[entry.path];
    const exists = entry.file ? Boolean(listing) : Array.isArray(listing);
    if (!exists) {
      if (entry.required) {
        return { fits: false, reason: `${entry.path} does not exist` };
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    if (entry.file) {
      sources.push(`appdata/${entry.path}`);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (entry.mustContain) {
      const matched = listing.some((file) => file && file.isFile
        && Number(file.size) > 0 && entry.mustContain.test(String(file.name)));
      if (!matched) {
        return { fits: false, reason: `${entry.path} holds no non-empty file matching ${entry.mustContain}` };
      }
    }
    if (entry.children && listing.some((item) => item.isDirectory && item.children === undefined)) {
      return { fits: false, reason: `${entry.path} holds more than ${MAX_CHILD_FOLDERS} folders to check` };
    }
    if (entry.validate) {
      const problem = entry.validate(listing);
      if (problem) {
        const { reason, unsettled } = typeof problem === 'string' ? { reason: problem } : problem;
        return { fits: false, reason: `${entry.path}: ${reason}`, ...(unsettled ? { unsettled: true } : {}) };
      }
    }
    if (entry.latest) {
      const newest = newestSettledFile(listing, entry.latest, now);
      if (newest) sources.push(`appdata/${entry.path}/${newest.name}`);
      else if (entry.required) return { fits: false, reason: `${entry.path} holds no settled file matching ${entry.latest.name}` };
    } else if (entry.children) {
      if (!listing.length && entry.required) return { fits: false, reason: `${entry.path} holds nothing to archive` };
      listing.forEach((item) => sources.push(`appdata/${entry.path}/${item.name}`));
    } else {
      sources.push(`appdata/${entry.path}`);
    }
  }
  return { fits: true, sources };
}

/**
 * Whether two collectProfileListings results describe the same files: every
 * entry, and the listed folders inside it, by name, kind, size and modifiedAt.
 * A folder's size counts all it holds, so a file written deeper still shows.
 * Taken before and after the archive is written, a difference means the volume
 * changed meanwhile (Syncthing delivering a save) and the archive may hold
 * half of it.
 */
function sameListings(before, after) {
  const describe = (listings) => {
    const lines = [];
    const add = (where, item) => {
      if (!item) return;
      lines.push([where, item.name, item.isDirectory ? 'd' : 'f', item.size, item.modifiedAt].join('|'));
      if (Array.isArray(item.children)) item.children.forEach((child) => add(`${where}/${item.name}`, child));
    };
    Object.keys(listings).forEach((entryPath) => {
      const listing = listings[entryPath];
      if (Array.isArray(listing)) listing.forEach((item) => add(entryPath, item));
      else if (listing) add(entryPath, listing);
      else lines.push(`${entryPath}|missing`);
    });
    return lines.sort().join('\n');
  };
  return describe(before) === describe(after);
}

module.exports = {
  PROFILE_MARKER_DIR,
  MAX_CHILD_FOLDERS,
  matchesComponent,
  profileForComponent,
  resolveComponentProfiles,
  collectProfileListings,
  planProfiledArchive,
  sameListings,
};
