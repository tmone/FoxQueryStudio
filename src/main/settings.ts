import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Registration } from '../shared/registry';
import type { ConnectionProfile } from '../shared/types';

/** Choices the user made that outlive a run, kept as JSON in the user data folder. */
export interface Settings {
  /** vfp9.exe chosen by the user, when FoxPro is not where the app looks by itself. */
  vfpPath?: string;
  /** Remembered connections; a SQL password is stored encrypted for this Windows user only. */
  registrations?: StoredRegistration[];
}

type StoredRegistration =
  | { id: string; kind: 'sql'; profile: Omit<ConnectionProfile, 'password'>; /** Base64 of the password encrypted by the OS (DPAPI). */ secret?: string }
  | { id: string; kind: 'foxpro'; path: string };

const FILE = 'settings.json';

const settingsFile = () => join(app.getPath('userData'), FILE);

export function readSettings(): Settings {
  try {
    return existsSync(settingsFile()) ? (JSON.parse(readFileSync(settingsFile(), 'utf8')) as Settings) : {};
  } catch {
    return {};
  }
}

export function writeSettings(change: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...change };
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

const sameServer = (a: Omit<ConnectionProfile, 'password'>, b: Omit<ConnectionProfile, 'password'>) =>
  a.server.toLowerCase() === b.server.toLowerCase() && (a.database ?? '').toLowerCase() === (b.database ?? '').toLowerCase() && a.user.toLowerCase() === b.user.toLowerCase();

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const stored = () => readSettings().registrations ?? [];
const save = (registrations: StoredRegistration[]) => writeSettings({ registrations });

/** What the window may see: never the secret itself, only whether there is one. */
export function listRegistrations(): Registration[] {
  return stored().map((r) => (r.kind === 'sql' ? { id: r.id, kind: 'sql', profile: r.profile, hasPassword: r.secret !== undefined } : r));
}

export function removeRegistration(id: string): void {
  save(stored().filter((r) => r.id !== id));
}

/**
 * Remembers a SQL connection and returns its id. The password is kept only when asked,
 * and only when the OS can encrypt it; an existing stored password survives a connect
 * that did not ask to remember.
 */
export function registerSql(profile: ConnectionProfile, rememberPassword: boolean): string {
  const { password, ...rest } = profile;
  const registrations = stored();
  const existing = registrations.find((r): r is StoredRegistration & { kind: 'sql' } => r.kind === 'sql' && sameServer(r.profile, rest));
  const secret = rememberPassword && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(password).toString('base64') : existing?.secret;
  const entry: StoredRegistration = { id: existing?.id ?? randomUUID(), kind: 'sql', profile: rest, secret };
  save([...registrations.filter((r) => r !== existing), entry]);
  return entry.id;
}

/**
 * Remembers a FoxPro database. A kit that was moved or copied brings the same database under a
 * new path: an entry for a same-named database whose file is gone is taken over rather than
 * left beside the new one.
 */
export function registerFoxPro(path: string): string {
  const name = basename(path).toLowerCase();
  const stale = (r: StoredRegistration) => r.kind === 'foxpro' && !samePath(r.path, path) && basename(r.path).toLowerCase() === name && !existsSync(r.path);
  const registrations = stored().filter((r) => !stale(r));
  const existing = registrations.find((r) => r.kind === 'foxpro' && samePath(r.path, path));
  const entry: StoredRegistration = existing ?? { id: randomUUID(), kind: 'foxpro', path };
  save(existing ? registrations : [...registrations, entry]);
  return entry.id;
}

/** The full profile of a remembered SQL connection, with its password when one is stored. */
export function sqlProfileOf(id: string): (ConnectionProfile & { hasPassword: boolean }) | undefined {
  const entry = stored().find((r) => r.id === id);
  if (entry?.kind !== 'sql') return undefined;
  const password = entry.secret && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(entry.secret, 'base64')) : '';
  return { ...entry.profile, password, hasPassword: Boolean(entry.secret) };
}

export function foxProPathOf(id: string): string | undefined {
  const entry = stored().find((r) => r.id === id);
  return entry?.kind === 'foxpro' ? entry.path : undefined;
}
