# Files published with each release

- `start.cmd` — put it in an empty folder and run it: downloads the latest `FoxQueryStudio-<version>.exe`,
  `FoxQueryStudio.config.json` and the Northwind sample next to it, then starts the program. Run it again
  later to pick up a newer release. Set `FQS_VFP_KIT_URL` to an internal address of `vfp9.zip`
  (Visual FoxPro 9: `vfp9.exe` and its DLLs, zipped without a top folder) to have it fetched too;
  FoxPro is not published here.
- `FoxQueryStudio.config.json` — settings read from the program's folder: FoxPro path, databases to open at start.
- `northwind-sample.zip` — built from `test/fixtures/northwind` (`npm run fixtures`) with `npm run release:assets`.

Publishing a version: bump `version` in `package.json`, `npm run dist`, `npm run release:assets`, then

    gh release create v<version> dist/FoxQueryStudio-<version>.exe dist/northwind-sample.zip release/FoxQueryStudio.config.json release/start.cmd
