/** A FoxPro database folder opened in the app's own local engine. */
export interface LocalDatabase {
  /** Folder the .dbf files were read from. */
  path: string;
  /** Name of the local database the tables were loaded into. */
  name: string;
  tableCount: number;
  rowCount: number;
  /** What was left out while loading, each with the reason. */
  notes: string[];
}

/** Window-level access to the local database, exposed through the preload bridge. */
export interface LocalDbApi {
  /**
   * Asks for a folder, loads its tables into the local engine and makes that database the
   * one queries run in. Undefined when the dialog is cancelled.
   */
  open(): Promise<LocalDatabase | undefined>;
}
