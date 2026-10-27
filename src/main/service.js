'use strict';
/*
 * The application API. It has no Electron dependency, so the exact same code is
 * called from Electron's IPC handlers, from the smoke test and from the automated
 * tests (including the browser UI tests).
 *
 * `invoke(method, args)` never throws: it resolves to { ok:true, data } or
 * { ok:false, message } where `message` is always safe to show to the user.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Backup = require('./backup.js');
const { ValidationError } = require('./store.js');

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function createService(store, options) {
  const dataDir = (options && options.dataDir) || require('node:path').dirname(store.file);
  const backupDir = path.join(dataDir, 'backups');
  const appVersion = (options && options.appVersion) || '0.0.0';
  const log = (options && options.log) || ((...a) => console.error(...a));
  const pending = new Map(); // token -> parsed backup (kept in memory only)

  function makeSafetyBackup(label) {
    fs.mkdirSync(backupDir, { recursive: true });
    let target = path.join(backupDir, 'study-tracker-' + label + '-' + stamp(new Date()) + '.db');
    let n = 1;
    while (fs.existsSync(target)) target = target.replace(/(\.\d+)?\.db$/, '.' + n++ + '.db');
    store.snapshotTo(target);
    return target;
  }

  const methods = {
    getMonth: (year, month) => store.getMonth(year, month),
    getEntry: (date) => store.getEntry(date),
    saveEntry: (entry) => store.saveEntry(entry),
    getSettings: () => store.getSettings(),
    setSettings: (patch) => store.setSettings(patch),

    getInfo: () => ({
      appVersion,
      dataDir,
      dbFile: store.file,
      backupDir,
      counts: store.counts()
    }),

    exportJson: () => {
      const now = new Date();
      const doc = Backup.buildExport(store.getAllEntries(), store.getSettings(), now);
      return { text: JSON.stringify(doc, null, 2), suggestedName: 'study-tracker-export-' + stamp(now) + '.json', entries: doc.entries.length };
    },

    exportCsv: () => {
      const now = new Date();
      return { text: Backup.buildCsv(store.getAllEntries()), suggestedName: 'study-tracker-summary-' + stamp(now) + '.csv' };
    },

    /** Full local backup: a consistent copy of the whole database file. */
    createBackup: () => {
      const file = makeSafetyBackup('backup');
      return { file, dir: backupDir };
    },

    /** Step 1 of a restore: validate only. Nothing is changed. */
    analyzeBackup: (text) => {
      const parsed = Backup.parseBackup(text);
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      const existing = store.existingDates();
      const overlapping = parsed.entries.filter((e) => existing.has(e.date)).length;
      const token = crypto.randomUUID();
      pending.clear();
      pending.set(token, parsed);
      return {
        ok: true,
        token,
        summary: {
          entries: parsed.entries.length,
          points: parsed.entries.reduce((n, e) => n + e.points.length, 0),
          overlapping,
          newDates: parsed.entries.length - overlapping,
          currentEntries: existing.size,
          hasSettings: !!parsed.settings,
          exportedAt: parsed.exportedAt
        }
      };
    },

    /** Step 2 of a restore. Overwrite/replace always take an automatic safety backup first. */
    applyBackup: (token, mode, includeSettings) => {
      const parsed = pending.get(token);
      if (!parsed) throw new ValidationError(['This restore request has expired. Please choose the backup file again.']);
      let safetyBackup = null;
      if ((mode === 'overwrite' || mode === 'replace') && store.counts().entries > 0) {
        safetyBackup = makeSafetyBackup('before-restore');
      }
      const result = store.applyEntries(parsed.entries, mode);
      if (includeSettings && parsed.settings) store.setSettings(parsed.settings);
      pending.delete(token);
      return Object.assign({}, result, { safetyBackup, settings: store.getSettings() });
    }
  };

  async function invoke(method, args) {
    if (!Object.prototype.hasOwnProperty.call(methods, method)) {
      return { ok: false, message: 'Unknown action.' };
    }
    try {
      const data = methods[method].apply(null, Array.isArray(args) ? args : []);
      return { ok: true, data };
    } catch (err) {
      if (err instanceof ValidationError) return { ok: false, message: err.errors.join(' ') };
      log('[study-tracker] ' + method + ' failed:', err);
      return { ok: false, message: 'Something went wrong and the action could not be completed. Your existing data was not changed.' };
    }
  }

  return { invoke, methods, backupDir, dataDir };
}

module.exports = { createService, stamp };
