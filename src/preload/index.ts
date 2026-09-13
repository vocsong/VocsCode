/** contextBridge surface: exposes the typed harness API to the sandboxed renderer as window.harness.
 *  The object is the shared Transport bound to Electron IPC; web builds bind the same Transport
 *  to a WebSocket (docs/REMOTE-ACCESS.md). */
import { contextBridge, ipcRenderer } from 'electron';
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