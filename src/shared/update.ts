export type UpdateState = 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  /** Version offered by the update server, once one is found. */
  newVersion?: string;
  /** Download progress, 0 to 100. */
  percent?: number;
  /** Why updates are disabled, or the last error. */
  message?: string;
}

/** API exposed to the renderer through the preload bridge. */
export interface UpdateApi {
  getStatus(): Promise<UpdateStatus>;
  check(): Promise<void>;
  download(): Promise<void>;
  /** Quits, installs the downloaded version and starts it. */
  install(): Promise<void>;
  /** Subscribes to status changes; returns the unsubscribe function. */
  onStatus(listener: (status: UpdateStatus) => void): () => void;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An update replaces the program, so the channel must not be open to tampering:
 * HTTPS only, except for a server on this machine (used when testing a release).
 */
export function isAllowedUpdateUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
}

/** Text of the toolbar button for each state; undefined when no button is shown. */
export function updateActionLabel(status: UpdateStatus): string | undefined {
  switch (status.state) {
    case 'available':
      return `Tải bản ${status.newVersion}`;
    case 'downloading':
      return `Đang tải ${Math.round(status.percent ?? 0)}%`;
    case 'downloaded':
      return `Khởi động lại để cập nhật ${status.newVersion}`;
    default:
      return undefined;
  }
}
