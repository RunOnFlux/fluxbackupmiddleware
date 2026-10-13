/**
 * Backup profiles: apps whose automatic backup archives only the data that
 * cannot be fetched again, instead of the component's whole appdata.
 *
 * A profile is matched by the component's image (the repotag without its tag).
 * `include` lists paths RELATIVE TO THE COMPONENT'S APPDATA, so the archive has
 * the same layout as the full one FluxOS's appendbackuptask writes: a restore
 * that unpacks it into appdata puts every file back where it was.
 *
 * What is left out has to be something the container rebuilds by itself on
 * start - typically a game server's install, which the image downloads again
 * from Steam. A path the app writes and nothing else can recreate belongs in
 * `include`.
 *
 *   path         the directory, relative to appdata
 *   required     the profile does not fit this app unless the directory exists
 *   mustContain  a file name pattern at least one non-empty file must match,
 *                so a copy that holds no world is never taken as a backup
 *
 * When a required path is missing, or holds nothing that matches, the app does
 * not have the layout the profile was written for (an older image, a server
 * that has not saved yet), and the backup falls back to the full archive.
 */
module.exports = [
  {
    // RuneScape: Dragonwilds. The volume is the image's whole DepotDownloader
    // install (~5.4 GB, ~1.9 GB compressed); the world, its settings and the
    // owner's pak mods are well under 1 MB of it.
    id: 'dragonwilds-world',
    images: ['indifferentbroccoli/runescape-dragonwilds-server-docker'],
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
];
