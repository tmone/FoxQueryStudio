import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Bookmark } from '../shared/journal';

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
  /** Queries the kit ships ready to run; added to the user's bookmarks once, by name. */
  bookmarks: SeedBookmark[];
}

export type SeedBookmark = Pick<Bookmark, 'name' | 'language' | 'sql'>;

/** A bookmark entry of the file: name and sql, language FoxPro unless `tsql` is said. */
function seedBookmark(raw: unknown): SeedBookmark | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { name, sql, language } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim() || typeof sql !== 'string' || !sql.trim()) return undefined;
  return { name: name.trim(), sql, language: language === 'tsql' ? 'tsql' : 'foxpro' };
}

const FILE = 'FoxQueryStudio.config.json';
const VFP_BESIDE = join('vfp9', 'vfp9.exe');

/**
 * The folder the settings live in: the portable .exe's folder; for the unpacked layout the
 * program folder itself or its parent (where start.cmd keeps them); the project in development.
 */
export function programFolder(packaged: boolean): string {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.env.PORTABLE_EXECUTABLE_FILE) return dirname(process.env.PORTABLE_EXECUTABLE_FILE);
  if (!packaged) return process.cwd();
  const own = dirname(process.execPath);
  const hasSettings = (folder: string) => existsSync(join(folder, FILE)) || existsSync(join(folder, VFP_BESIDE));
  return hasSettings(own) ? own : hasSettings(dirname(own)) ? dirname(own) : own;
}

export function readSideConfig(folder: string): SideConfig {
  const at = (p: string) => (isAbsolute(p) ? p : resolve(folder, p));
  let raw: { vfpPath?: unknown; openOnStart?: unknown; bookmarks?: unknown } = {};
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
  const bookmarks = Array.isArray(raw.bookmarks) ? raw.bookmarks.map(seedBookmark).filter((b): b is SeedBookmark => !!b) : [];
  return { vfpPath, openOnStart, bookmarks };
}
