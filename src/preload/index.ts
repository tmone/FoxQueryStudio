import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi, AppCommand } from '../shared/commands';
import type { JournalApi } from '../shared/journal';
import type { RegistryApi } from '../shared/registry';
import type { DbApi } from '../shared/types';
import type { UpdateApi, UpdateStatus } from '../shared/update';

const api: DbApi = {
  connect: (profile, rememberPassword) => ipcRenderer.invoke('db:connect', profile, rememberPassword),
  connectSaved: (id, password) => ipcRenderer.invoke('db:connectSaved', id, password),
  openFoxPro: () => ipcRenderer.invoke('local:open'),
  disconnect: (id) => ipcRenderer.invoke('db:disconnect', id),
  listDatabases: (id) => ipcRenderer.invoke('db:databases', id),
  loadSchema: (id, database) => ipcRenderer.invoke('db:schema', id, database),
  execute: (id, sessionId, sql, maxRows, database) => ipcRenderer.invoke('db:execute', id, sessionId, sql, maxRows, database),
  callProcedure: (id, sessionId, statement, maxRows, database, cursor) => ipcRenderer.invoke('db:callProcedure', id, sessionId, statement, maxRows, database, cursor),
  closeSession: (id, sessionId) => ipcRenderer.invoke('db:closeSession', id, sessionId),
};

const registry: RegistryApi = {
  list: () => ipcRenderer.invoke('registry:list'),
  startup: () => ipcRenderer.invoke('registry:startup'),
  remove: (id) => ipcRenderer.invoke('registry:remove', id),
};

const journal: JournalApi = {
  history: (filter) => ipcRenderer.invoke('journal:history', filter),
  record: (entry) => ipcRenderer.invoke('journal:record', entry),
  clearHistory: () => ipcRenderer.invoke('journal:clearHistory'),
  historyPath: () => ipcRenderer.invoke('journal:historyPath'),
  bookmarks: () => ipcRenderer.invoke('journal:bookmarks'),
  saveBookmark: (bookmark) => ipcRenderer.invoke('journal:saveBookmark', bookmark),
  removeBookmark: (id) => ipcRenderer.invoke('journal:removeBookmark', id),
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
  exportExcel: (sheets, suggestedName) => ipcRenderer.invoke('export:xlsx', sheets, suggestedName),
  getVfpPath: () => ipcRenderer.invoke('vfp:getPath'),
  chooseVfpPath: () => ipcRenderer.invoke('vfp:choose'),
};

contextBridge.exposeInMainWorld('db', api);
contextBridge.exposeInMainWorld('app', appApi);
contextBridge.exposeInMainWorld('registry', registry);
contextBridge.exposeInMainWorld('updates', updates);
contextBridge.exposeInMainWorld('journal', journal);
