'use strict';
// Loaded with `node --require` to run src/main/main.js in --smoke-test mode against a fake Electron.
// Behaviour is chosen with FAKE_RENDERER = never-loads | no-appready | ok-fatal
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const mode = process.env.FAKE_RENDERER || 'never-loads';
const base = process.env.FAKE_BASE;

class FakeWC extends EventEmitter {
  setWindowOpenHandler() {}
  send() {}
  isLoading() { return mode === 'never-loads'; }
  getURL() { return 'file:///fake/index.html'; }
  reload() { setImmediate(() => this.emit('did-finish-load')); }
  executeJavaScript(code) {
    if (mode === 'never-loads') return new Promise(() => {});
    if (/typeof window\.__appReady/.test(code) && /readyState/.test(code)) {
      return Promise.resolve({ href: 'file:///fake/index.html', readyState: 'complete', api: mode === 'no-appready' ? 'undefined' : 'object', appReady: mode === 'no-appready' ? 'undefined' : 'object' });
    }
    if (code.trim() === 'window.__appReady') return Promise.resolve(false);
    if (/document\.getElementById\('calendar'\)/.test(code)) return Promise.resolve('Study Tracker could not start\nThe connection is missing');
    return Promise.resolve({ title: 'x' });
  }
}
class FakeWindow {
  constructor(options) { this.options = options; this.webContents = new FakeWC(); }
  once() {} on() {} loadFile() {} show() {} isDestroyed() { return false; } close() {}
}
const fakeElectron = {
  app: {
    isPackaged: false,
    setPath: (k, v) => { fakeElectron._paths[k] = v; },
    getPath: (k) => fakeElectron._paths[k] || path.join(base, k),
    getVersion: () => '0.0.0', requestSingleInstanceLock: () => true,
    on() {}, whenReady: () => Promise.resolve(), quit() {}, disableHardwareAcceleration() {},
    exit: (c) => process.exit(c)
  },
  BrowserWindow: FakeWindow,
  ipcMain: { handle() {}, on() {} },
  dialog: { showErrorBox() {} },
  shell: {}, nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
  session: { defaultSession: { webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {} } },
  Menu: { setApplicationMenu() {} },
  _paths: {}
};
const orig = Module._load;
Module._load = function (request, parent, isMain) { return request === 'electron' ? fakeElectron : orig.call(this, request, parent, isMain); };
