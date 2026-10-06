import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi, AppCommand } from '../shared/commands';
import type { LocalDbApi } from '../shared/local-db';
import type { DbApi } from '../shared/types';
import type { UpdateApi, UpdateStatus } from '../shared/update';

const api: DbApi = {
  connect: (profile) => ipcRenderer.invoke('db:connect', profile),
  disconnect: () => ipcRenderer.invoke('db:disconnect'),
  loadSchema: () => ipcRenderer.invoke('db:schema'),
  execute: (sessionId, sql, maxRows) => ipcRenderer.invoke('db:execute', sessionId, sql, maxRows),
  closeSession: (sessionId) => ipcRenderer.invoke('db:closeSession', sessionId),
};

const localDb: LocalDbApi = {
  open: () => ipcRenderer.invoke('local:open'),
};

const updates: UpdateApi = {
  getStatus: () => ipcRenderer.invoke('update:getStatus'),
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  onStatus: (listener) => {
    const handler = (_event: unknown, status: UpdateStatus) => listener(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
};

const appApi: AppApi & { about(): Promise<void> } = {
  onCommand: (listener) => {
    const handler = (_event: unknown, command: AppCommand) => listener(command);
    ipcRenderer.on('app:command', handler);
    return () => ipcRenderer.removeListener('app:command', handler);
  },
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (path, content, suggestedName) => ipcRenderer.invoke('file:save', path, content, suggestedName),
  about: () => ipcRenderer.invoke('app:about'),
};

contextBridge.exposeInMainWorld('db', api);
contextBridge.exposeInMainWorld('localDb', localDb);
contextBridge.exposeInMainWorld('app', appApi);
contextBridge.exposeInMainWorld('updates', updates);
