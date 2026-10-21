import { contextBridge, ipcRenderer } from "electron";
import type { LauncherAPI } from "../shared/types";
const api: LauncherAPI = {
  call: (method, payload) =>
    ipcRenderer.invoke("launcher:call", method, payload),
  onEvent: (callback) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on("launcher:event", listener);
    return () => ipcRenderer.removeListener("launcher:event", listener);
  },
  window: (action) => ipcRenderer.send("launcher:window", action),
};
contextBridge.exposeInMainWorld("launcher", api);
