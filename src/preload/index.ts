import { contextBridge, ipcRenderer } from 'electron';
import type { VocsDeskApi } from '../shared/ipc';

const api: VocsDeskApi = {
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld('harness', api);
