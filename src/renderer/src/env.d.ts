/// <reference types="vite/client" />
import type { AppApi } from '../../shared/commands';
import type { DbApi } from '../../shared/types';
import type { UpdateApi } from '../../shared/update';

declare global {
  interface Window {
    db: DbApi;
    app: AppApi & { about(): Promise<void> };
    updates: UpdateApi;
  }
}
