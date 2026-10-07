import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ConnectionInfo, ConnectionProfile, DbBackend, SchemaTable } from '../shared/types';
import type { SqlDatabase } from './db';
import type { FoxEngine } from './fox-engine';

/** FoxPro keeps the path of a table's database container in the last 263 bytes of the .dbf header. */
const HEADER_SIZE_OFFSET = 8;
const BACKLINK_LENGTH = 263;
const FOXPRO_SERVER = 'FoxPro';

/** The .dbc a table belongs to, when the header names one and it exists next to the table. */
export function databaseOfTable(dbfPath: string): string | undefined {
  const fd = openSync(dbfPath, 'r');
  try {
    const sizeBytes = Buffer.alloc(2);
    readSync(fd, sizeBytes, 0, 2, HEADER_SIZE_OFFSET);
    const headerSize = sizeBytes.readUInt16LE(0);
    if (headerSize <= BACKLINK_LENGTH) return undefined;
    const buffer = Buffer.alloc(BACKLINK_LENGTH);
    const read = readSync(fd, buffer, 0, BACKLINK_LENGTH, headerSize - BACKLINK_LENGTH);
    const end = buffer.indexOf(0);
    const link = buffer.subarray(0, end < 0 ? read : end).toString('latin1').trim();
    if (!link) return undefined;
    const dbc = resolve(dirname(dbfPath), link);
    return existsSync(dbc) ? dbc : undefined;
  } finally {
    closeSync(fd);
  }
}

/** What to open for a file the user picked: its container when it has one, else the folder of free tables. */
export function foxDatabaseTarget(path: string): { open: string; info: Pick<ConnectionInfo, 'database' | 'localPath'> } {
  const name = (p: string) => p.split(/[\\/]/).filter(Boolean).pop()!;
  if (statSync(path).isDirectory()) return { open: path, info: { database: name(path), localPath: path } };
  const dbc = path.toLowerCase().endsWith('.dbc') ? path : databaseOfTable(path);
  if (dbc) return { open: dbc, info: { database: name(dbc), localPath: dbc } };
  const folder = dirname(path);
  return { open: folder, info: { database: name(folder), localPath: folder } };
}

interface Connection {
  info: ConnectionInfo;
  backend: DbBackend;
}

/**
 * The open connections, each with the backend that serves it. The window addresses them
 * by id, so a SQL Server and several FoxPro databases can be open side by side.
 */
export function createConnections(newSqlDatabase: () => SqlDatabase, newFoxEngine: () => FoxEngine) {
  const connections = new Map<string, Connection>();

  function get(id: string): Connection {
    const connection = connections.get(id);
    if (!connection) throw new Error('Kết nối này đã đóng.');
    return connection;
  }

  return {
    /** Opens a SQL Server connection under the given id (its registration); an open one with that id is replaced. */
    async connectSql(profile: ConnectionProfile, id: string): Promise<ConnectionInfo> {
      await this.disconnect(id);
      const backend = newSqlDatabase();
      await backend.connect(profile);
      const info: ConnectionInfo = { id, kind: 'sql', server: profile.server, user: profile.user, database: profile.database };
      connections.set(info.id, { info, backend });
      return info;
    },

    async openFoxPro(path: string, id: string): Promise<ConnectionInfo> {
      await this.disconnect(id);
      const target = foxDatabaseTarget(path);
      const backend = newFoxEngine();
      await backend.openDatabase(target.open);
      const info: ConnectionInfo = { id, kind: 'foxpro', server: FOXPRO_SERVER, user: '', ...target.info };
      connections.set(info.id, { info, backend });
      return info;
    },

    /** Gives an open connection another id, closing whatever held the new id before. */
    async rename(id: string, newId: string): Promise<ConnectionInfo> {
      const connection = get(id);
      if (id === newId) return connection.info;
      await this.disconnect(newId);
      connections.delete(id);
      connection.info = { ...connection.info, id: newId };
      connections.set(newId, connection);
      return connection.info;
    },

    async disconnect(id: string): Promise<void> {
      const connection = connections.get(id);
      if (!connection) return;
      connections.delete(id);
      await connection.backend.disconnect();
    },

    async disconnectAll(): Promise<void> {
      const all = [...connections.keys()];
      await Promise.allSettled(all.map((id) => this.disconnect(id)));
    },

    loadSchema: (id: string): Promise<SchemaTable[]> => get(id).backend.loadSchema(),
    execute: (id: string, sessionId: string, sql: string, maxRows: number) => get(id).backend.execute(sessionId, sql, maxRows),
    closeSession: (id: string, sessionId: string) => connections.get(id)?.backend.closeSession(sessionId) ?? Promise.resolve(),
  };
}

export type Connections = ReturnType<typeof createConnections>;
