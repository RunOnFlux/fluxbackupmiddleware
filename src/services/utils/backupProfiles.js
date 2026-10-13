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
 * Decide what to archive from the node's listings of the profile's paths.
 *
 * @param {object} profile
 * @param {Object<string, Array|null>} listings - path -> getfolderinfo entries,
 *   or null when the directory does not exist
 * @returns {{fits: true, sources: string[]} | {fits: false, reason: string}}
 *   sources are relative to the VOLUME root, as compressobject takes them
 */
function planProfiledArchive(profile, listings) {
  const sources = [`appdata/${PROFILE_MARKER_DIR}`];
  for (let i = 0; i < profile.include.length; i += 1) {
    const entry = profile.include[i];
    const listing = listings[entry.path];
    if (!Array.isArray(listing)) {
      if (entry.required) {
        return { fits: false, reason: `${entry.path} does not exist` };
      }
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
    sources.push(`appdata/${entry.path}`);
  }
  return { fits: true, sources };
}

module.exports = {
  PROFILE_MARKER_DIR,
  matchesComponent,
  profileForComponent,
  resolveComponentProfiles,
  planProfiledArchive,
};
