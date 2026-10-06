// Windows installer and update feed.
//
//   FQS_UPDATE_URL   folder on a web server where releases are published (HTTPS).
//                    Without it the installer is built with self-update turned off.
//   FQS_DIST_DIR     output folder, default "dist".
//
// A release is published by copying latest.yml, the Setup .exe and its .blockmap
// from the output folder to FQS_UPDATE_URL.

const updateUrl = process.env.FQS_UPDATE_URL;

// Same rule the app applies at run time (src/shared/update.ts): an update replaces
// the program, so it must not travel over a channel that can be tampered with.
if (updateUrl && !/^https:\/\//.test(updateUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(updateUrl)) {
  throw new Error(`FQS_UPDATE_URL must use HTTPS: ${updateUrl}`);
}

module.exports = {
  appId: 'com.surehcs.foxquerystudio',
  productName: 'FoxQuery Studio',
  directories: { output: process.env.FQS_DIST_DIR || 'dist' },
  files: ['out/**', 'build/icon.png', 'package.json'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    // Regenerate with scripts/make-icon.ps1 when the artwork changes.
    icon: 'build/icon.ico',
    // The installer is not code-signed yet; the icon and version details are still written into the .exe.
    signExecutable: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: 'FoxQueryStudio-Setup-${version}.${ext}',
  },
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
};
