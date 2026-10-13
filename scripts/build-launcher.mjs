// Compiles launcher/Launcher.cs into dist/FoxQueryStudio-Launcher.exe with the C# compiler that
// ships with the .NET Framework on every Windows, and stamps it with the program icon.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const csc = join(process.env.SystemRoot ?? 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const dist = process.env.FQS_DIST_DIR || 'dist';
mkdirSync(dist, { recursive: true });
const out = join(dist, 'FoxQueryStudio-Launcher.exe');
// csc reads a leading slash as an option, so paths are given with backslashes.
execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${out}`, `/win32icon:${join('build', 'icon.ico')}`, '/reference:System.Windows.Forms.dll', join('launcher', 'Launcher.cs')], { stdio: 'inherit' });
console.log(out);
