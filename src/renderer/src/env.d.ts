/// <reference types="vite/client" />
import type { AppApi } from '../../shared/commands';
import type { RegistryApi } from '../../shared/registry';
import type { DbApi } from '../../shared/types';
import type { UpdateApi } from '../../shared/update';

declare global {
  interface Window {
    db: DbApi;
    registry: RegistryApi;
    app: AppApi & { about(): Promise<void> };
    updates: UpdateApi;
  }
}
