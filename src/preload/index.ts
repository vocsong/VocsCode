/** contextBridge surface: exposes the typed harness API to the sandboxed renderer as window.harness. */
import { contextBridge, ipcRenderer } from 'electron';
import type { VocsCodeApi } from '../shared/ipc';

const api: VocsCodeApi = {
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld('harness', api);
