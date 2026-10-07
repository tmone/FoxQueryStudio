import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi, AppCommand } from '../shared/commands';
import type { RegistryApi } from '../shared/registry';
import type { DbApi } from '../shared/types';
import type { UpdateApi, UpdateStatus } from '../shared/update';

const api: DbApi = {
  connect: (profile, rememberPassword) => ipcRenderer.invoke('db:connect', profile, rememberPassword),
  connectSaved: (id, password) => ipcRenderer.invoke('db:connectSaved', id, password),
  openFoxPro: () => ipcRenderer.invoke('local:open'),
  disconnect: (id) => ipcRenderer.invoke('db:disconnect', id),
  loadSchema: (id) => ipcRenderer.invoke('db:schema', id),
  execute: (id, sessionId, sql, maxRows) => ipcRenderer.invoke('db:execute', id, sessionId, sql, maxRows),
  closeSession: (id, sessionId) => ipcRenderer.invoke('db:closeSession', id, sessionId),
};

const registry: RegistryApi = {
  list: () => ipcRenderer.invoke('registry:list'),
  startup: () => ipcRenderer.invoke('registry:startup'),
  remove: (id) => ipcRenderer.invoke('registry:remove', id),
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
  getVfpPath: () => ipcRenderer.invoke('vfp:getPath'),
  chooseVfpPath: () => ipcRenderer.invoke('vfp:choose'),
};

contextBridge.exposeInMainWorld('db', api);
contextBridge.exposeInMainWorld('app', appApi);
contextBridge.exposeInMainWorld('registry', registry);
contextBridge.exposeInMainWorld('updates', updates);
