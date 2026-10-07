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
  remove(id: string): Promise<void>;
}
