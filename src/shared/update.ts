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

/** GitHub repository whose releases carry new versions of the program. */
export const UPDATE_REPO = 'tmone/FoxQueryStudio';
export const latestReleaseUrl = (repo: string) => `https://api.github.com/repos/${repo}/releases/latest`;

export interface ReleaseAsset {
  name: string;
  url: string;
  /** SHA-256 of the file as lower-case hex, as GitHub publishes it. */
  sha256?: string;
}

export interface Release {
  version: string;
  /** The single-file program (.exe). */
  asset?: ReleaseAsset;
  /** The unpacked program folder (.zip), which starts much faster. */
  folder?: ReleaseAsset;
  /** The app code alone (app.asar, ~10 MB), usable when the installed Electron is the one it was built for. */
  app?: ReleaseAsset & { electron: string };
}

/** Name of the app-only asset: the Electron version is part of it, so an update knows whether it fits. */
export const appAssetName = (version: string, electron: string) => `FoxQueryStudio-${version}-app-electron${electron}.asar`;
const APP_ASSET = /^FoxQueryStudio-.*-app-electron(\d+\.\d+\.\d+)\.asar$/i;

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** True when `candidate` is a later x.y.z version than `current`; a malformed version never is. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = VERSION.exec(candidate);
  const b = VERSION.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return false;
}

/** Reads the answer of GitHub's "latest release" API: the version from the tag, and the program file. */
export function parseRelease(body: unknown): Release | undefined {
  const release = body as { tag_name?: unknown; assets?: unknown };
  if (typeof release?.tag_name !== 'string' || !VERSION.test(release.tag_name)) return undefined;
  const assets = Array.isArray(release.assets) ? (release.assets as { name?: unknown; browser_download_url?: unknown; digest?: unknown }[]) : [];
  const find = (pattern: RegExp): ReleaseAsset | undefined => {
    const found = assets.find((a) => typeof a.name === 'string' && pattern.test(a.name) && typeof a.browser_download_url === 'string');
    if (!found) return undefined;
    const digest = typeof found.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(found.digest)?.[1].toLowerCase() : undefined;
    return { name: found.name as string, url: found.browser_download_url as string, sha256: digest };
  };
  const app = find(APP_ASSET);
  return {
    version: release.tag_name.replace(/^v/, ''),
    asset: find(/^FoxQueryStudio-.*\.exe$/i),
    folder: find(/^FoxQueryStudio-.*\.zip$/i),
    app: app ? { ...app, electron: APP_ASSET.exec(app.name)![1] } : undefined,
  };
}
