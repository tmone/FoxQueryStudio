export interface ConnectionProfile {
  /** As SSMS writes it: host, host\instance, host,port or host\instance,port. */
  server: string;
  /** Database to start in; empty means the login's default, and every database is listed anyway. */
  database?: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

export interface SchemaColumn {
  name: string;
  dataType: string;
  /** How the type is shown when it differs from dataType, e.g. a FoxPro field as C(40) or nvarchar(150). */
  display?: string;
  /** Character length; -1 for the (max) types. */
  maxLength: number | null;
  nullable: boolean;
  /** Part of the primary key, or of a foreign key, as the object explorer marks it. */
  keyRole?: 'PK' | 'FK';
}

/** A primary, foreign or unique key constraint. */
export interface SchemaKey {
  name: string;
  kind: 'PK' | 'FK' | 'UQ';
  columns: string[];
}

export interface SchemaIndex {
  name: string;
  unique: boolean;
  clustered: boolean;
  primary: boolean;
  /** Key columns in order; for FoxPro, the tag's expression. */
  columns: string[];
}

export interface SchemaTable {
  schema: string;
  name: string;
  isView: boolean;
  columns: SchemaColumn[];
  keys?: SchemaKey[];
  indexes?: SchemaIndex[];
}

export type CellValue = string | number | boolean | null;

export interface ResultSet {
  columns: string[];
  rows: CellValue[][];
}

export interface ExecuteResult {
  resultSets: ResultSet[];
  messages: string[];
  error?: string;
  /** True when rows were cut off at the row limit. */
  truncated: boolean;
  /** True when the session had to be replaced, which drops its temp tables (cursors). */
  sessionReset?: boolean;
  elapsedMs: number;
}

/** An open connection: a SQL Server database, or a FoxPro database on disk run by FoxPro itself. */
export interface ConnectionInfo {
  id: string;
  kind: 'sql' | 'foxpro';
  server: string;
  user: string;
  database: string;
  /** The .dbc or folder of a FoxPro database. */
  localPath?: string;
}

/** API exposed to the renderer through the preload bridge. Several connections can be open at once. */
export interface DbApi {
  /** Connects and remembers the connection; the password is stored encrypted only when asked. */
  connect(profile: ConnectionProfile, rememberPassword: boolean): Promise<ConnectionInfo>;
  /**
   * Reopens a remembered connection. A SQL registration without a stored password needs one
   * passed in; otherwise the call fails with NEEDS_PASSWORD.
   */
  connectSaved(registrationId: string, password?: string): Promise<ConnectionInfo>;
  /** Asks for a .dbc or .dbf file and opens that database in FoxPro; undefined when the dialog is cancelled. */
  openFoxPro(): Promise<ConnectionInfo | undefined>;
  disconnect(connectionId: string): Promise<void>;
  /** Databases the login can open on the connection; a FoxPro connection has exactly one. */
  listDatabases(connectionId: string): Promise<string[]>;
  loadSchema(connectionId: string, database: string): Promise<SchemaTable[]>;
  /** `database` is the one the batch runs in; it is switched to at the start of the batch. */
  execute(connectionId: string, sessionId: string, sql: string, maxRows: number, database?: string): Promise<ExecuteResult>;
  closeSession(connectionId: string, sessionId: string): Promise<void>;
}

/** One connection's worth of the database service: what createDatabase and createFoxEngine implement. */
export interface DbBackend {
  disconnect(): Promise<void>;
  listDatabases(): Promise<string[]>;
  loadSchema(database?: string): Promise<SchemaTable[]>;
  execute(sessionId: string, sql: string, maxRows: number, database?: string): Promise<ExecuteResult>;
  closeSession(sessionId: string): Promise<void>;
}
