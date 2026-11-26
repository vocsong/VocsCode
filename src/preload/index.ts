/** contextBridge surface: exposes the typed harness API to the sandboxed renderer as window.harness,
 *  the shared Transport bound to Electron IPC. */
import { contextBridge, ipcRenderer } from 'electron';
import { KEEP_AWAKE_CHANNEL, type KeepAwakeBridge } from '../shared/keep-awake';
import type { Transport } from '../shared/transport';

const api: Transport = {
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld('harness', api);

const keepAwake: KeepAwakeBridge = { preference: (request) => ipcRenderer.invoke(KEEP_AWAKE_CHANNEL, request) };
contextBridge.exposeInMainWorld('keepAwake', keepAwake);