const defaultProfiles = require('../../../config/backupProfiles');

/**
 * Empty directory created at the root of appdata and archived with a profile's
 * paths. Archiving it makes appdata the archive's common parent, so members keep
 * their appdata-relative names (RSDragonwilds/Saved/...), exactly as in a full
 * backup. Without it the root would move down to the deepest folder the listed
 * paths share. Its presence also marks an archive as partial.
 */
const PROFILE_MARKER_DIR = '.flux-backup';

/**
 * The image a repotag names, without registry host, tag or digest, lowercased.
 * `docker.io/Foo/bar:1.2@sha256:...` -> `foo/bar`.
 */
function imageOf(repotag) {
  let image = String(repotag || '').trim().toLowerCase();
  [image] = image.split('@');
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  if (lastColon > lastSlash) image = image.slice(0, lastColon);
  image = image.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '');
  return image;
}

function profileForRepotag(repotag, profiles = defaultProfiles) {
  const image = imageOf(repotag);
  if (!image) return null;
  return profiles.find((profile) => profile.images.some((candidate) => imageOf(candidate) === image)) || null;
}

/**
 * The profile for every component, or null when any component has none.
 *
 * All or nothing because a node backs up a whole app in one stop: mixing a
 * profiled archive with appendbackuptask would stop the app for the full
 * archive anyway and save nothing.
 *
 * @param {string[]} componentNames - the components to back up
 * @param {string[]} specComponentNames - component names as the spec lists them
 * @param {string[]} repotags - repotags in the same order as specComponentNames
 * @returns {Object<string, object>|null} component name -> profile
 */
function resolveComponentProfiles(componentNames, specComponentNames, repotags, profiles = defaultProfiles) {
  if (!Array.isArray(componentNames) || componentNames.length === 0) return null;
  if (!Array.isArray(specComponentNames) || !Array.isArray(repotags)) return null;
  const result = {};
  for (let i = 0; i < componentNames.length; i += 1) {
    const index = specComponentNames.indexOf(componentNames[i]);
    if (index === -1) return null;
    const profile = profileForRepotag(repotags[index], profiles);
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
  imageOf,
  profileForRepotag,
  resolveComponentProfiles,
  planProfiledArchive,
};
