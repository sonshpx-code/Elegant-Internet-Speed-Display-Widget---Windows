'use strict';

/**
 * 渲染进程唯一的对外通道。`contextIsolation: true` + `nodeIntegration: false`，
 * 页面永远拿不到 ipcRenderer 本身，只能调这些具名方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('netHud', {
  /** 页面就绪：请主进程把 shell 与当前样本推过来。 */
  ready: () => ipcRenderer.send('net:ready'),

  /* 拖动只有意图，没有几何：位置与吸附全在主进程手里。 */
  dragStart: () => ipcRenderer.send('net:drag-start'),
  dragEnd: (moved) => ipcRenderer.send('net:drag-end', moved === true),

  menu: () => ipcRenderer.send('net:menu'),

  loadPrefs: () => ipcRenderer.invoke('net:load-prefs'),
  savePrefs: (patch) => ipcRenderer.send('net:save-prefs', patch),
  diagnostics: () => ipcRenderer.invoke('net:diagnostics'),

  /** 返回退订函数，页面重载时不会堆积监听器。 */
  onCommand: (handler) => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on('net:command', listener);
    return () => ipcRenderer.removeListener('net:command', listener);
  },
});
