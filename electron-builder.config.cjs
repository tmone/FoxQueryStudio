// Builds the program as one portable .exe: nothing to install, copy it anywhere and run.
//
//   FQS_DIST_DIR     output folder, default "dist".
//
// A release is published by attaching that .exe to a GitHub release tagged v<version>
// (see UPDATE_REPO in src/shared/update.ts); running copies find it at their next start.
//
// build/vfp is optional and not in the repository: when it holds a Visual FoxPro engine
// (vfp9.exe with its DLLs), it travels inside the .exe so FoxPro databases open on machines
// without Visual FoxPro. Only put files there that you are licensed to hand out.
const { existsSync } = require('node:fs');

module.exports = {
  appId: 'com.surehcs.foxquerystudio',
  productName: 'FoxQuery Studio',
  directories: { output: process.env.FQS_DIST_DIR || 'dist' },
  // Everything the program needs is in out/: the main script bundles its dependencies.
  files: ['out/**', 'build/icon.png', 'package.json', '!node_modules/**'],
  extraResources: existsSync('build/vfp') ? [{ from: 'build/vfp', to: 'vfp' }] : [],
  win: {
    // The .zip is the unpacked folder: it opens in about a second, where the single .exe unpacks itself first.
    target: [{ target: 'portable', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
    artifactName: 'FoxQueryStudio-${version}-${os}.${ext}',
    // Regenerate with scripts/make-icon.ps1 when the artwork changes.
    icon: 'build/icon.ico',
    // The program is not code-signed yet; the icon and version details are still written into the .exe.
    signExecutable: false,
  },
  portable: {
    artifactName: 'FoxQueryStudio-${version}.${ext}',
    // A fixed folder, so a start reuses what the previous one unpacked instead of unpacking again.
    unpackDirName: 'FoxQueryStudio',
  },
  publish: null,
};
