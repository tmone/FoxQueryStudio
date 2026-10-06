export interface ConnectionProfile {
  server: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

export interface SchemaColumn {
  name: string;
  dataType: string;
  /** How the type is shown when it differs from dataType, e.g. a FoxPro field as C(40). */
  display?: string;
  /** Character length; -1 for the (max) types. */
  maxLength: number | null;
  nullable: boolean;
}

export interface SchemaTable {
  schema: string;
  name: string;
  isView: boolean;
  columns: SchemaColumn[];
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

/** API exposed to the renderer through the preload bridge. */
export interface DbApi {
  connect(profile: ConnectionProfile): Promise<void>;
  disconnect(): Promise<void>;
  loadSchema(): Promise<SchemaTable[]>;
  execute(sessionId: string, sql: string, maxRows: number): Promise<ExecuteResult>;
  closeSession(sessionId: string): Promise<void>;
}
