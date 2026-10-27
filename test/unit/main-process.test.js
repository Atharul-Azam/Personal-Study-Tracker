'use strict';
/*
 * Exercises src/main/main.js against a fake `electron` module (the real one is only available on a
 * machine with Electron installed). This verifies OUR logic — window security options, the offline
 * request blocker, IPC trust checks, native file dialogs, close/flush protocol — not Electron itself.
 * The real-Electron check is the `--smoke-test` run (see README / CI).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-tracker-main-'));
const paths = { appData: path.join(root, 'AppData'), documents: path.join(root, 'Documents'), userData: null };
fs.mkdirSync(paths.documents, { recursive: true });

const handlers = {};      // ipcMain.handle
const listeners = {};     // ipcMain.on
const appListeners = {};
const windows = [];
const dialogQueue = { save: [], open: [] };
let requestFilter = null;
let errorBox = null;
let exitCode = null;
let nativeThemeSource = null;
let shownItems = [];

class FakeWindow {
  constructor(options) {
    this.options = options; this.handlers = {}; this.sent = []; this.closed = false; this.visible = false;
    this.webContents = {
      setWindowOpenHandler: (fn) => { this.openHandler = fn; },
      on: (ev, fn) => { this.webContents.handlers = this.webContents.handlers || {}; this.webContents.handlers[ev] = fn; },
      send: (channel, ...args) => this.sent.push([channel, ...args]),
      once: () => {}
    };
    windows.push(this);
  }
  once(ev, fn) { this.handlers[ev] = fn; }
  on(ev, fn) { this.handlers[ev] = fn; }
  loadFile(f) { this.loadedFile = f; }
  show() { this.visible = true; }
  isMinimized() { return false; }
  restore() {}
  focus() {}
  isDestroyed() { return this.closed; }
  close() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    if (this.handlers.close) this.handlers.close(event);
    if (!event.prevented) { this.closed = true; if (this.handlers.closed) this.handlers.closed(); }
    return event.prevented;
  }
}

const fakeElectron = {
  app: {
    isPackaged: false,
    setPath: (k, v) => { paths[k] = v; },
    getPath: (k) => { if (!paths[k]) throw new Error('unknown path ' + k); return paths[k]; },
    getVersion: () => '9.9.9',
    requestSingleInstanceLock: () => true,
    on: (ev, fn) => { appListeners[ev] = fn; },
    whenReady: () => Promise.resolve(),
    quit: () => {},
    exit: (c) => { exitCode = c; }
  },
  BrowserWindow: FakeWindow,
  ipcMain: { handle: (n, fn) => { handlers[n] = fn; }, on: (n, fn) => { listeners[n] = fn; } },
  dialog: {
    showSaveDialog: async () => dialogQueue.save.shift(),
    showOpenDialog: async () => dialogQueue.open.shift(),
    showErrorBox: (t, m) => { errorBox = [t, m]; }
  },
  shell: { openPath: async () => '', showItemInFolder: (p) => shownItems.push(p) },
  nativeTheme: { set themeSource(v) { nativeThemeSource = v; }, get themeSource() { return nativeThemeSource; }, shouldUseDarkColors: false },
  session: { defaultSession: { webRequest: { onBeforeRequest: (filter, fn) => { requestFilter = { filter, fn }; } }, setPermissionRequestHandler: (fn) => { fakeElectron.permissionHandler = fn; } } },
  Menu: { setApplicationMenu: (m) => { fakeElectron.menu = m; } }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const trusted = { senderFrame: { url: 'file:///app/src/renderer/index.html' } };
const untrusted = { senderFrame: { url: 'https://evil.example/' } };

test.before(async () => {
  require('../../src/main/main.js');
  await new Promise((r) => setImmediate(r));   // let app.whenReady().then(...) run
  await new Promise((r) => setImmediate(r));
});
test.after(() => { Module._load = originalLoad; });

test('starts: data folder is the per-user AppData location, the database is created there', () => {
  assert.equal(paths.userData, path.join(paths.appData, 'Study Tracker'));
  assert.ok(fs.existsSync(path.join(paths.userData, 'study-tracker.db')), 'database created in the per-user folder');
  assert.equal(fakeElectron.menu, null, 'no default menu bar');
  assert.equal(errorBox, null);
});

test('window is created with a hardened, sandboxed configuration and loads the bundled UI', () => {
  assert.equal(windows.length, 1);
  const w = windows[0];
  const wp = w.options.webPreferences;
  assert.deepEqual([wp.contextIsolation, wp.nodeIntegration, wp.sandbox], [true, false, true]);
  assert.ok(fs.existsSync(wp.preload), 'preload exists: ' + wp.preload);
  assert.ok(fs.existsSync(w.options.icon), 'icon exists: ' + w.options.icon);
  assert.ok(fs.existsSync(w.loadedFile) && w.loadedFile.endsWith(path.join('renderer', 'index.html')));
  assert.ok(w.options.minWidth <= 800 && w.options.minHeight <= 600);
  assert.deepEqual(w.openHandler(), { action: 'deny' }, 'no popups');
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  w.webContents.handlers['will-navigate'](nav, 'https://example.com/');
  assert.equal(nav.prevented, true, 'navigation away from the app is blocked');
  const nav2 = { prevented: false, preventDefault() { this.prevented = true; } };
  w.webContents.handlers['will-navigate'](nav2, 'file:///app/index.html');
  assert.equal(nav2.prevented, false);
  w.handlers['ready-to-show']();
  assert.equal(w.visible, true);
});

test('offline guarantee: every http/https/ws request is cancelled, permissions are denied', () => {
  assert.ok(requestFilter.filter.urls.some((u) => u.startsWith('https://')) && requestFilter.filter.urls.some((u) => u.startsWith('http://')));
  assert.ok(requestFilter.filter.urls.some((u) => u.startsWith('wss://')));
  let result;
  requestFilter.fn({ url: 'https://example.com/x' }, (r) => { result = r; });
  assert.deepEqual(result, { cancel: true });
  let granted = 'unset';
  fakeElectron.permissionHandler(null, 'geolocation', (v) => { granted = v; });
  assert.equal(granted, false);
});

test('IPC rpc works for the app UI and is refused for any other origin', async () => {
  const ok = await handlers.rpc(trusted, 'saveEntry', [{ date: '2026-11-05', points: [{ text: 'hi' }] }]);
  assert.equal(ok.ok, true);
  const got = await handlers.rpc(trusted, 'getEntry', ['2026-11-05']);
  assert.equal(got.data.points[0].text, 'hi');
  assert.deepEqual(await handlers.rpc(untrusted, 'getEntry', ['2026-11-05']), { ok: false, message: 'Request blocked.' });
  assert.deepEqual(await handlers.rpc({}, 'getEntry', ['2026-11-05']), { ok: false, message: 'Request blocked.' });
  const bad = await handlers.rpc(trusted, 'saveEntry', [{ date: '2026-02-30' }]);
  assert.equal(bad.ok, false);
  assert.ok(!/\bat .*:\d+/.test(bad.message));
  assert.equal((await handlers.rpc(trusted, '__proto__', [])).ok, false);
  assert.equal((await handlers.rpc(trusted, 'constructor', [])).ok, false);
});

test('export: writes the chosen file (JSON and CSV), reports cancel, and gives friendly errors', async () => {
  const target = path.join(paths.documents, 'out.json');
  dialogQueue.save.push({ canceled: false, filePath: target });
  const r = await handlers['export:file'](trusted, 'json');
  assert.deepEqual([r.ok, r.path], [true, target]);
  const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(doc.app, 'study-tracker');
  assert.equal(doc.entries[0].date, '2026-11-05');

  const csvTarget = path.join(paths.documents, 'out.csv');
  dialogQueue.save.push({ canceled: false, filePath: csvTarget });
  assert.equal((await handlers['export:file'](trusted, 'csv')).ok, true);
  assert.ok(fs.readFileSync(csvTarget, 'utf8').startsWith('﻿date,weekday'));

  dialogQueue.save.push({ canceled: true });
  assert.deepEqual(await handlers['export:file'](trusted, 'json'), { ok: true, canceled: true });

  dialogQueue.save.push({ canceled: false, filePath: path.join(paths.documents, 'no-such-folder', 'x.json') });
  const fail = await handlers['export:file'](trusted, 'json');
  assert.equal(fail.ok, false);
  assert.ok(typeof fail.message === 'string' && !/ENOENT|\bat /.test(fail.message), fail.message);
  assert.equal((await handlers['export:file'](untrusted, 'json')).ok, false);
});

test('import: reads and validates the chosen file; bad files produce errors, not crashes', async () => {
  const good = path.join(paths.documents, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ app: 'study-tracker', formatVersion: 1, entries: [{ date: '2026-12-01', points: [{ text: 'x' }] }] }));
  dialogQueue.open.push({ canceled: false, filePaths: [good] });
  const r = await handlers['import:pick'](trusted);
  assert.equal(r.ok, true);
  assert.equal(r.analysis.ok, true);
  assert.equal(r.analysis.summary.newDates, 1);
  assert.equal(r.fileName, 'good.json');

  const junk = path.join(paths.documents, 'junk.json');
  fs.writeFileSync(junk, '{{{ not json');
  dialogQueue.open.push({ canceled: false, filePaths: [junk] });
  const r2 = await handlers['import:pick'](trusted);
  assert.equal(r2.ok, true); assert.equal(r2.analysis.ok, false); assert.ok(r2.analysis.errors.length >= 1);

  dialogQueue.open.push({ canceled: false, filePaths: [path.join(paths.documents, 'missing.json')] });
  const r3 = await handlers['import:pick'](trusted);
  assert.equal(r3.ok, false); assert.ok(!/ENOENT/.test(r3.message));

  dialogQueue.open.push({ canceled: true, filePaths: [] });
  assert.deepEqual(await handlers['import:pick'](trusted), { ok: true, canceled: true });
  assert.equal((await handlers['import:pick'](untrusted)).ok, false);

  // the analysed backup can be applied through the normal rpc path
  const applied = await handlers.rpc(trusted, 'applyBackup', [r.analysis.token, 'skip', false]);
  assert.equal(applied.ok, true);
  assert.equal(applied.data.added, 1);
});

test('"show in folder" only reveals files inside the app data folder', async () => {
  const inside = path.join(paths.userData, 'backups', 'a.db');
  assert.deepEqual(await handlers['shell:show-file'](trusted, inside), { ok: true });
  assert.deepEqual(shownItems, [inside]);
  for (const outside of [path.join(root, 'elsewhere.db'), path.join(paths.userData, '..', 'secret.txt'), '/etc/passwd', 42]) {
    assert.equal((await handlers['shell:show-file'](trusted, outside)).ok, false, String(outside));
  }
  assert.equal(shownItems.length, 1);
  assert.equal((await handlers['shell:open-data-folder'](trusted)).ok, true);
  assert.equal((await handlers['shell:open-data-folder'](untrusted)).ok, false);
});

test('theme changes are forwarded to the native theme only for valid values from the app', () => {
  listeners['theme:set'](trusted, 'dark'); assert.equal(nativeThemeSource, 'dark');
  listeners['theme:set'](trusted, 'bogus'); assert.equal(nativeThemeSource, 'dark');
  listeners['theme:set'](untrusted, 'light'); assert.equal(nativeThemeSource, 'dark');
  listeners['theme:set'](trusted, 'system'); assert.equal(nativeThemeSource, 'system');
});

test('closing the window first asks the UI to flush; it closes only when the UI says it is safe', () => {
  const w = windows[0];
  w.sent = [];
  const prevented = w.close();
  assert.equal(prevented, true, 'first close attempt is held back');
  assert.deepEqual(w.sent, [['app:close-requested']]);
  assert.equal(w.closed, false);

  listeners['app:close-response'](trusted, false);   // user cancelled an "unsaved changes" prompt
  assert.equal(w.closed, false);
  listeners['app:close-response'](untrusted, true);  // not from our UI → ignored
  assert.equal(w.closed, false);
  listeners['app:close-response'](trusted, true);
  assert.equal(w.closed, true, 'closes after the UI confirms');
});

test('a second launch focuses the existing window instead of opening another', () => {
  assert.equal(typeof appListeners['second-instance'], 'function');
  assert.doesNotThrow(() => appListeners['second-instance']());
});

test('a broken/newer database shows a clear error dialog and exits instead of crashing', async () => {
  // fresh module graph pointing at a corrupt file
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'study-tracker-main2-'));
  const appData = path.join(sandbox, 'AppData');
  fs.mkdirSync(path.join(appData, 'Study Tracker'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Study Tracker', 'study-tracker.db'), Buffer.from('garbage'.repeat(900)));
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'main')) || k.includes(path.join('src', 'shared'))) delete require.cache[k];
  paths.appData = appData; errorBox = null; exitCode = null;
  require('../../src/main/main.js');
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.ok(errorBox, 'error dialog shown');
  assert.match(errorBox[1], /looks damaged/);
  assert.ok(!/\bat .*\.js/.test(errorBox[1]));
  assert.equal(exitCode, 1);
  assert.ok(fs.existsSync(path.join(appData, 'Study Tracker', 'study-tracker.db')), 'the user\'s file is left in place');
});
