/** A FoxPro database opened from disk and queried with FoxPro itself. */
export interface LocalDatabase {
  /** The database container (.dbc), or the folder of free tables. */
  path: string;
  /** Short name shown in the object explorer. */
  name: string;
}

/** Window-level access to the FoxPro database, exposed through the preload bridge. */
export interface LocalDbApi {
  /**
   * Asks for a .dbc or .dbf file and makes that database the one queries run in.
   * Undefined when the dialog is cancelled.
   */
  open(): Promise<LocalDatabase | undefined>;
}
