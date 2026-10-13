# Files published with each release

- `start.cmd` — put it in an empty folder and run it: downloads the latest `FoxQueryStudio-<version>-win.zip`
  (the unpacked program, which opens in about a second; the single .exe unpacks itself at every start and
  takes ~9 s), unpacks it into `app\`, fetches the Northwind sample and `FoxQuery Studio.exe` (a 90 KB launcher that starts
  `app\FoxQuery Studio.exe`; Electron must sit among its own DLLs, so the real program cannot be at the top), then starts it. Run it again
  later to pick up a newer release. Set `FQS_VFP_KIT_URL` to an internal address of `vfp9.zip`
  (Visual FoxPro 9: `vfp9.exe` and its DLLs, zipped without a top folder) to have it fetched too;
  FoxPro is not published here.
- `FoxQueryStudio.config.json` — settings read from the program's folder: FoxPro path, databases to open at start.
- `FoxQueryStudio-Launcher.exe` — the launcher placed at the top of a kit folder; built from `launcher/Launcher.cs`
  with the C# compiler of the .NET Framework by `npm run release:assets`. Updates never touch it. Before starting the
  program it finishes an update left waiting (`app.new` or `appesourcespp.asar.new` next to the current copy), so a
  version whose own swap helper failed (0.2.11 and earlier) still comes up as the new one at the next start.
- `FoxQueryStudio-<version>-app-electron<electron>.asar` — the app code alone (~10 MB). A copy running from the
  unpacked folder on the same Electron updates with this file instead of the whole program; `npm run release:assets` makes it.
- `northwind-sample.zip` — built from `test/fixtures/northwind` (`npm run fixtures`) with `npm run release:assets`.

Publishing a version: bump `version` in `package.json`, `npm run dist`, `npm run release:assets`, then

    gh release create v<version> dist/FoxQueryStudio-<version>.exe dist/FoxQueryStudio-<version>-win.zip dist/FoxQueryStudio-<version>-app-electron*.asar dist/FoxQueryStudio-Launcher.exe dist/northwind-sample.zip release/FoxQueryStudio.config.json release/start.cmd
