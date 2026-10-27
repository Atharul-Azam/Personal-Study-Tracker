'use strict';
/*
 * Electron main process.
 *
 * Responsibilities: single-instance window, per-user data folder, SQLite store,
 * native file dialogs for backup/restore, hard offline guarantees (all http/https/ws
 * requests are cancelled), and a --smoke-test mode used by CI to prove that the
 * built app really starts and persists data.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SMOKE = process.argv.includes('--smoke-test');
const smokeOutArg = process.argv.find((a) => a.startsWith('--smoke-out='));
const SMOKE_OUT = smokeOutArg ? smokeOutArg.slice('--smoke-out='.length) : null;

// Data lives in the per-user application-data folder (never inside the install
// directory), so it survives restarts, updates and re-installs.
// Windows: %APPDATA%\Study Tracker
if (SMOKE) {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'study-tracker-smoke-')));
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'Study Tracker'));
}

const { createStore } = require('./store.js');
const { createService } = require('./service.js');
const { DatabaseInitError } = require('./db.js');
const Dates = require('../shared/dates.js');

let store = null;
let service = null;
let mainWindow = null;
let allowClose = false;

function dbFile() {
  return path.join(app.getPath('userData'), 'study-tracker.db');
}

function isTrustedSender(event) {
  try {
    return event.senderFrame && event.senderFrame.url.startsWith('file://');
  } catch (_) {
    return false;
  }
}

function friendlyFsError(err, verb) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') return 'Study Tracker is not allowed to ' + verb + ' there. Choose a different folder.';
  if (code === 'ENOSPC') return 'The disk is full, so the file could not be ' + (verb === 'write to that location' ? 'written' : 'read') + '.';
  if (code === 'ENOENT') return 'That file or folder could not be found.';
  return 'The file could not be ' + (verb === 'write to that location' ? 'written' : 'read') + '.';
}

function registerIpc() {
  ipcMain.handle('rpc', async (event, method, args) => {
    if (!isTrustedSender(event)) return { ok: false, message: 'Request blocked.' };
    return service.invoke(String(method), Array.isArray(args) ? args : []);
  });

  ipcMain.handle('export:file', async (event, kind) => {
    if (!isTrustedSender(event)) return { ok: false, message: 'Request blocked.' };
    const isCsv = kind === 'csv';
    const r = await service.invoke(isCsv ? 'exportCsv' : 'exportJson', []);
    if (!r.ok) return r;
    const pick = await dialog.showSaveDialog(mainWindow, {
      title: isCsv ? 'Export summary as CSV' : 'Export all study records',
      defaultPath: path.join(app.getPath('documents'), r.data.suggestedName),
      filters: isCsv ? [{ name: 'CSV (spreadsheet)', extensions: ['csv'] }] : [{ name: 'JSON backup', extensions: ['json'] }]
    });
    if (pick.canceled || !pick.filePath) return { ok: true, canceled: true };
    try {
      await fs.promises.writeFile(pick.filePath, r.data.text, 'utf8');
    } catch (err) {
      return { ok: false, message: friendlyFsError(err, 'write to that location') };
    }
    return { ok: true, path: pick.filePath };
  });

  ipcMain.handle('import:pick', async (event) => {
    if (!isTrustedSender(event)) return { ok: false, message: 'Request blocked.' };
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a Study Tracker backup (.json)',
      properties: ['openFile'],
      filters: [{ name: 'JSON backup', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (pick.canceled || !pick.filePaths.length) return { ok: true, canceled: true };
    let text;
    try {
      const stat = await fs.promises.stat(pick.filePaths[0]);
      if (stat.size > 200 * 1024 * 1024) return { ok: false, message: 'That file is too large to be a Study Tracker backup.' };
      text = await fs.promises.readFile(pick.filePaths[0], 'utf8');
    } catch (err) {
      return { ok: false, message: friendlyFsError(err, 'read that file') };
    }
    const r = await service.invoke('analyzeBackup', [text]);
    if (!r.ok) return r;
    return { ok: true, analysis: r.data, fileName: path.basename(pick.filePaths[0]) };
  });

  ipcMain.handle('shell:open-data-folder', async (event) => {
    if (!isTrustedSender(event)) return { ok: false };
    const err = await shell.openPath(app.getPath('userData'));
    return err ? { ok: false, message: 'Could not open the folder.' } : { ok: true };
  });

  ipcMain.handle('shell:show-file', async (event, file) => {
    if (!isTrustedSender(event) || typeof file !== 'string') return { ok: false };
    const base = app.getPath('userData');
    const resolved = path.resolve(file);
    if (!resolved.startsWith(base + path.sep)) return { ok: false };
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  ipcMain.on('theme:set', (event, theme) => {
    if (!isTrustedSender(event)) return;
    if (theme === 'light' || theme === 'dark' || theme === 'system') nativeTheme.themeSource = theme;
  });

  ipcMain.on('app:close-response', (event, canClose) => {
    if (!isTrustedSender(event)) return;
    if (canClose && mainWindow) {
      allowClose = true;
      mainWindow.close();
    }
  });
}

function hardenSession() {
  // Hard offline guarantee: nothing may leave this machine, even by accident.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (details, callback) => {
    callback({ cancel: true });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function createWindow() {
  const theme = store.getSettings().theme;
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  nativeTheme.themeSource = theme;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Study Tracker',
    backgroundColor: dark ? '#17181a' : '#f6f4ef',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => { if (!SMOKE) mainWindow.show(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  // Give the renderer a chance to flush unsaved edits before the window closes.
  mainWindow.on('close', (event) => {
    if (allowClose || SMOKE) return;
    event.preventDefault();
    mainWindow.webContents.send('app:close-requested');
    // Safety net: never trap the user in an unresponsive window.
    setTimeout(() => { allowClose = true; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); }, 8000).unref();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ---------------------------------------------------------------------------
// --smoke-test: launched by CI against the real packaged .exe.
// ---------------------------------------------------------------------------
async function runSmokeTest() {
  const result = { ok: false, checks: [], userData: app.getPath('userData'), electron: process.versions.electron, node: process.versions.node, platform: process.platform };
  const check = (name, pass, detail) => result.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });
  const wc = mainWindow.webContents;
  const waitLoad = () => new Promise((resolve) => wc.once('did-finish-load', resolve));
  const evalJs = (code) => wc.executeJavaScript(code, true);
  try {
    if (wc.isLoading()) await waitLoad();
    await evalJs('window.__appReady');
    await new Promise((r) => setTimeout(r, 300));

    const now = Dates.todayParts();
    const expectedDays = Dates.daysInMonth(now.year, now.month);
    const ui = await evalJs(`(() => {
      const cells = [...document.querySelectorAll('.day[data-date]')];
      const prefix = ${JSON.stringify(Dates.monthKey(now.year, now.month) + '-')};
      return { days: cells.length, allInMonth: cells.every((c) => c.dataset.date.startsWith(prefix)),
               title: document.getElementById('title-text') && document.getElementById('title-text').textContent,
               hasApi: typeof window.api === 'object' };
    })()`);
    check('window opens with preload API', ui.hasApi);
    check('calendar shows current month title', ui.title === Dates.MONTH_NAMES[now.month - 1] + ' ' + now.year, ui.title);
    check('calendar shows exactly the days of this month', ui.days === expectedDays, ui.days + ' of ' + expectedDays);
    check('no dates from adjacent months', ui.allInMonth);

    const today = Dates.todayISO();
    const save = await evalJs(`window.api.rpc('saveEntry', [{ date: ${JSON.stringify(today)}, points: [{ text: 'smoke test ✓ বাংলা' }], review: 'persisted', status: 'in_progress', durationMin: 5 }])`);
    check('saving a journal entry works', save && save.ok, save && save.message);

    const net = await evalJs(`fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'REACHED', () => 'BLOCKED')`);
    check('network requests are blocked (offline-only)', net === 'BLOCKED', net);

    const reloaded = waitLoad();
    wc.reload();
    await reloaded;
    await evalJs('window.__appReady');
    await new Promise((r) => setTimeout(r, 300));
    const after = await evalJs(`(() => { const t = document.querySelector('.day.today'); return { hasNotes: !!(t && t.classList.contains('has-notes')), text: document.querySelector('#editor') ? document.querySelector('#editor').innerText : '' }; })()`);
    check('entry still shown after reload', after.hasNotes);
    check('journal editor restores saved text', /smoke test ✓ বাংলা/.test(after.text) || (await evalJs(`[...document.querySelectorAll('.point-text')].map(t => t.value).join('|')`)).includes('smoke test ✓ বাংলা'));

    // Prove it hit the disk: close the store and read the file back with a fresh connection.
    store.close();
    const reopened = createStore(dbFile());
    const back = reopened.getEntry(today);
    reopened.close();
    check('data is on disk in the per-user folder', back.points.length === 1 && back.review === 'persisted' && dbFile().startsWith(app.getPath('userData')), dbFile());
    result.ok = result.checks.every((c) => c.pass);
  } catch (err) {
    check('smoke test ran without exceptions', false, String(err && err.stack || err));
  }
  const json = JSON.stringify(result, null, 2);
  if (SMOKE_OUT) { try { fs.writeFileSync(SMOKE_OUT, json); } catch (_) { /* ignore */ } }
  console.log(json);
  allowClose = true;
  app.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    hardenSession();
    try {
      store = createStore(dbFile());
    } catch (err) {
      const message = err instanceof DatabaseInitError ? err.message : 'Study Tracker could not start. ' + String(err && err.message);
      dialog.showErrorBox('Study Tracker could not open your data', message);
      app.exit(1);
      return;
    }
    service = createService(store, { dataDir: app.getPath('userData'), appVersion: app.getVersion() });
    registerIpc();
    createWindow();
    if (SMOKE) {
      mainWindow.webContents.once('did-finish-load', () => { runSmokeTest(); });
      setTimeout(() => { console.log('SMOKE TEST TIMEOUT'); app.exit(2); }, 60000).unref();
    }
  });

  app.on('window-all-closed', () => {
    try { if (store) store.close(); } catch (_) { /* ignore */ }
    app.quit();
  });
}
