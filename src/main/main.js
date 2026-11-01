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
  // Headless CI runners have no usable GPU; software rendering avoids GPU-process stalls there.
  if (typeof app.disableHardwareAcceleration === 'function') app.disableHardwareAcceleration();
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'Study Tracker'));
}

const { createStore } = require('./store.js');
const { createService } = require('./service.js');
const { DatabaseInitError } = require('./db.js');
const Dates = require('../shared/dates.js');
const Smoke = require('./smoke.js');

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
      spellcheck: false,
      backgroundThrottling: !SMOKE
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
// --smoke-test: launched by CI against the real unpackaged / packaged / installed app.
// The report file is written from the very first moment and at every step, so a hang or crash
// still leaves an explanation behind (see smoke.js).
// ---------------------------------------------------------------------------
let smokeReport = null;
let smokeExited = false;

function smokeExit(code) {
  if (smokeExited) return;
  smokeExited = true;
  if (smokeReport) {
    smokeReport.finish(code === 0);
    console.log(JSON.stringify(smokeReport.result, null, 2));
  }
  allowClose = true;
  app.exit(code);
}

function startSmokeReport() {
  smokeReport = Smoke.createReport(SMOKE_OUT, {
    userData: app.getPath('userData'),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    packaged: !!app.isPackaged,
    argv: process.argv.slice(1)
  });
  smokeReport.stage('main process started');
  process.on('uncaughtException', (err) => {
    smokeReport.check('no uncaught exception in the main process', false, String(err && err.stack || err));
    smokeExit(1);
  });
  process.on('unhandledRejection', (err) => { smokeReport.log('unhandledRejection: ' + String(err && err.stack || err)); });
  if (typeof app.on === 'function') {
    app.on('child-process-gone', (_e, details) => smokeReport.log('child-process-gone: ' + JSON.stringify(details)));
  }
  // Watchdog: independent of everything else. Whatever stage we are stuck in is in the report.
  const limit = Number(process.env.STUDY_TRACKER_SMOKE_TIMEOUT_MS) || 60000;
  setTimeout(() => {
    smokeReport.check('finished within ' + Math.round(limit / 1000) + ' s (stuck at stage "' + smokeReport.result.stage + '")', false);
    smokeExit(2);
  }, limit);
}

function watchWindowForSmoke(win) {
  const wc = win.webContents;
  wc.on('console-message', (e, level, message, line, source) => {
    const text = typeof message === 'string' ? message : (e && e.message);   // Electron 35+ passes one details object
    const lvl = typeof message === 'string' ? level : (e && e.level);
    const src = typeof message === 'string' ? source : (e && e.sourceId);
    const ln = typeof message === 'string' ? line : (e && e.lineNumber);
    smokeReport.log('renderer console [' + lvl + '] ' + text + (src ? ' (' + path.basename(String(src)) + ':' + ln + ')' : ''));
  });
  wc.on('preload-error', (_e, preloadPath, error) => smokeReport.log('PRELOAD ERROR in ' + preloadPath + ': ' + String(error && error.stack || error)));
  wc.on('did-fail-load', (_e, code, desc, url) => smokeReport.log('did-fail-load ' + code + ' ' + desc + ' ' + url));
  wc.on('render-process-gone', (_e, details) => { smokeReport.log('RENDERER PROCESS GONE: ' + JSON.stringify(details)); });
  wc.on('unresponsive', () => smokeReport.log('renderer is unresponsive'));
  wc.on('dom-ready', () => smokeReport.log('dom-ready'));
  wc.on('did-finish-load', () => smokeReport.log('did-finish-load'));
}

// ---------------------------------------------------------------------------

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (SMOKE) startSmokeReport();

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (SMOKE) smokeReport.stage('electron ready');
    Menu.setApplicationMenu(null);
    hardenSession();
    try {
      store = createStore(dbFile());
    } catch (err) {
      const message = err instanceof DatabaseInitError ? err.message : 'Study Tracker could not start. ' + String(err && err.message);
      if (SMOKE) {
        smokeReport.check('database opens', false, message + (err && err.stack ? '\n' + err.stack : ''));
        smokeExit(1);
        return;
      }
      dialog.showErrorBox('Study Tracker could not open your data', message);
      app.exit(1);
      return;
    }
    service = createService(store, { dataDir: app.getPath('userData'), appVersion: app.getVersion() });
    registerIpc();
    createWindow();
    if (SMOKE) {
      watchWindowForSmoke(mainWindow);
      smokeReport.stage('window created');
      Smoke.run({
        wc: mainWindow.webContents,
        report: smokeReport,
        Dates,
        userData: app.getPath('userData'),
        dbFile: dbFile(),
        closeStore: () => store.close(),
        openStore: () => createStore(dbFile())
      }).then((ok) => smokeExit(ok ? 0 : 1), (err) => {
        smokeReport.check('smoke runner crashed', false, String(err && err.stack || err));
        smokeExit(1);
      });
    }
  }).catch((err) => {
    if (SMOKE) { smokeReport.check('start-up threw', false, String(err && err.stack || err)); smokeExit(1); }
    else { dialog.showErrorBox('Study Tracker could not start', String(err && err.message)); app.exit(1); }
  });

  app.on('window-all-closed', () => {
    try { if (store) store.close(); } catch (_) { /* ignore */ }
    app.quit();
  });
}
