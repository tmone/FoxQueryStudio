import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Optional settings placed next to the program, so a copy handed to someone works at
 * first start: FoxQueryStudio.config.json in the folder of the .exe. Paths are relative
 * to that folder. A vfp9\vfp9.exe folder next to the program is used even without the file.
 */
export interface SideConfig {
  /** vfp9.exe to run FoxPro databases with. */
  vfpPath?: string;
  /** FoxPro databases (.dbc, .dbf or folder) to open when the program starts. */
  openOnStart: string[];
}

const FILE = 'FoxQueryStudio.config.json';
const VFP_BESIDE = join('vfp9', 'vfp9.exe');

/** The folder the user started the program from: the portable .exe's folder, or the project in development. */
export function programFolder(): string {
  return process.env.PORTABLE_EXECUTABLE_DIR ?? (process.env.PORTABLE_EXECUTABLE_FILE ? dirname(process.env.PORTABLE_EXECUTABLE_FILE) : process.cwd());
}

export function readSideConfig(folder = programFolder()): SideConfig {
  const at = (p: string) => (isAbsolute(p) ? p : resolve(folder, p));
  let raw: { vfpPath?: unknown; openOnStart?: unknown } = {};
  const file = join(folder, FILE);
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      raw = {};
    }
  }
  const vfpPath = typeof raw.vfpPath === 'string' ? at(raw.vfpPath) : existsSync(join(folder, VFP_BESIDE)) ? join(folder, VFP_BESIDE) : undefined;
  const openOnStart = Array.isArray(raw.openOnStart) ? raw.openOnStart.filter((p): p is string => typeof p === 'string').map(at).filter(existsSync) : [];
  return { vfpPath, openOnStart };
}
