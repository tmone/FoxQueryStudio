import type { ConnectionProfile } from './types';

/**
 * A remembered connection, shown in the object explorer whether or not it is open, like
 * a registered server in SSMS. It stays until the user removes it.
 */
export type Registration =
  | { id: string; kind: 'sql'; profile: Omit<ConnectionProfile, 'password'>; /** True when the password is stored (encrypted) with it. */ hasPassword: boolean }
  | { id: string; kind: 'foxpro'; /** The .dbc, or the folder of free tables. */ path: string };

/** Registry operations exposed to the window. */
export interface RegistryApi {
  list(): Promise<Registration[]>;
  /** Registrations the program was told to open at start (FoxQueryStudio.config.json next to it). */
  startup(): Promise<string[]>;
  remove(id: string): Promise<void>;
}
