import { contextBridge, ipcRenderer } from 'electron'
import { createHostApi } from './host-bridge'

contextBridge.exposeInMainWorld('rill', createHostApi(ipcRenderer))
