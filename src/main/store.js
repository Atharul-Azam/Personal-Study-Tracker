'use strict';
/*
 * Data access layer. Every write that touches more than one row runs inside a
 * single transaction, so a crash can never leave a day half-saved.
 */
const Dates = require('../shared/dates.js');
const Model = require('../shared/model.js');
const { openDatabase } = require('./db.js');

class ValidationError extends Error {
  constructor(errors) {
    super(errors.join(' '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function createStore(file) {
  const db = openDatabase(file);

  const q = {
    entry: db.prepare('SELECT * FROM entries WHERE date = ?'),
    points: db.prepare('SELECT text, done FROM points WHERE date = ? ORDER BY position'),
    upsertEntry: db.prepare(
      `INSERT INTO entries (date, review, duration_min, status, tags, rating, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET review = excluded.review, duration_min = excluded.duration_min,
         status = excluded.status, tags = excluded.tags, rating = excluded.rating, updated_at = excluded.updated_at`
    ),
    delPoints: db.prepare('DELETE FROM points WHERE date = ?'),
    insPoint: db.prepare('INSERT INTO points (date, position, text, done) VALUES (?, ?, ?, ?)'),
    delEntry: db.prepare('DELETE FROM entries WHERE date = ?'),
    monthEntries: db.prepare('SELECT date, review, duration_min, status, tags, rating FROM entries WHERE date >= ? AND date <= ? ORDER BY date'),
    monthPoints: db.prepare('SELECT date, position, text, done FROM points WHERE date >= ? AND date <= ? ORDER BY date, position'),
    allEntries: db.prepare('SELECT date, review, duration_min, status, tags, rating FROM entries ORDER BY date'),
    allPoints: db.prepare('SELECT date, text, done FROM points ORDER BY date, position'),
    existingDates: db.prepare('SELECT date FROM entries'),
    countEntries: db.prepare('SELECT COUNT(*) AS n FROM entries'),
    countPoints: db.prepare('SELECT COUNT(*) AS n FROM points'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    allSettings: db.prepare('SELECT key, value FROM settings'),
    putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    delAllEntries: db.prepare('DELETE FROM entries')
  };

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  function parseTags(text) {
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
    } catch (_) {
      return [];
    }
  }

  function rowToEntry(row, points) {
    return {
      date: row.date,
      points: points.map((p) => ({ text: p.text, done: !!p.done })),
      review: row.review,
      durationMin: row.duration_min === null ? null : Number(row.duration_min),
      status: row.status,
      tags: parseTags(row.tags),
      rating: row.rating === null ? null : Number(row.rating)
    };
  }

  /** Writes an already-validated entry. Must be called inside a transaction. */
  function writeEntry(entry) {
    if (Model.isEmptyEntry(entry)) {
      q.delEntry.run(entry.date); // points are removed by ON DELETE CASCADE
      return false;
    }
    const ts = nowIso();
    q.upsertEntry.run(entry.date, entry.review, entry.durationMin, entry.status, JSON.stringify(entry.tags), entry.rating, ts, ts);
    q.delPoints.run(entry.date);
    entry.points.forEach((p, i) => q.insPoint.run(entry.date, i, p.text, p.done ? 1 : 0));
    return true;
  }

  const api = {
    file,

    getEntry(date) {
      if (!Dates.isValidISO(date)) throw new ValidationError(['Invalid date "' + String(date) + '".']);
      const row = q.entry.get(date);
      if (!row) return Model.blankEntry(date);
      return rowToEntry(row, q.points.all(date));
    },

    /** Replaces the whole journal for ONE date. Other dates are never touched. */
    saveEntry(input) {
      const v = Model.validateEntry(input);
      if (!v.ok) throw new ValidationError(v.errors);
      const stored = transaction(() => writeEntry(v.entry));
      return { date: v.entry.date, stored };
    },

    deleteEntry(date) {
      if (!Dates.isValidISO(date)) throw new ValidationError(['Invalid date "' + String(date) + '".']);
      transaction(() => q.delEntry.run(date));
      return { date };
    },

    /** Lightweight per-day summaries for one month (what the calendar needs). */
    getMonth(year, month) {
      if (!Dates.isValidYearMonth(year, month)) throw new ValidationError(['Invalid month ' + year + '/' + month + '.']);
      const range = Dates.monthRange(year, month);
      const days = {};
      for (const row of q.monthEntries.all(range.start, range.end)) {
        days[row.date] = {
          points: 0,
          firstPoints: [],
          done: 0,
          review: row.review !== '',
          status: row.status,
          durationMin: row.duration_min === null ? null : Number(row.duration_min),
          rating: row.rating === null ? null : Number(row.rating),
          tags: parseTags(row.tags)
        };
      }
      for (const p of q.monthPoints.all(range.start, range.end)) {
        const d = days[p.date];
        if (!d) continue;
        d.points += 1;
        if (p.done) d.done += 1;
        if (d.firstPoints.length < 3) d.firstPoints.push(p.text.split('\n')[0].slice(0, 120));
      }
      return { year, month, days, stats: api.statsFromDays(days) };
    },

    statsFromDays(days) {
      const stats = { studyDays: 0, completedDays: 0, learningPoints: 0, reviewDays: 0, totalMinutes: 0, daysWithDuration: 0 };
      for (const date of Object.keys(days)) {
        const d = days[date];
        if (Model.isStudyDay(d)) stats.studyDays += 1;
        if (d.status === 'completed') stats.completedDays += 1;
        if (d.review) stats.reviewDays += 1;
        stats.learningPoints += d.points;
        if (d.durationMin) { stats.totalMinutes += d.durationMin; stats.daysWithDuration += 1; }
      }
      return stats;
    },

    getSettings() {
      const raw = {};
      for (const row of q.allSettings.all()) {
        try { raw[row.key] = JSON.parse(row.value); } catch (_) { /* ignore corrupt value, default applies */ }
      }
      return Object.assign({}, Model.DEFAULT_SETTINGS, Model.sanitizeSettings(raw));
    },

    setSettings(patch) {
      const clean = Model.sanitizeSettings(patch);
      transaction(() => {
        for (const key of Object.keys(clean)) q.putSetting.run(key, JSON.stringify(clean[key]));
      });
      return api.getSettings();
    },

    /** Everything, for JSON export / CSV export. */
    getAllEntries() {
      const byDate = new Map();
      const entries = [];
      for (const row of q.allEntries.all()) {
        const e = rowToEntry(row, []);
        byDate.set(row.date, e);
        entries.push(e);
      }
      for (const p of q.allPoints.all()) {
        const e = byDate.get(p.date);
        if (e) e.points.push({ text: p.text, done: !!p.done });
      }
      return entries;
    },

    counts() {
      return { entries: Number(q.countEntries.get().n), points: Number(q.countPoints.get().n) };
    },

    existingDates() {
      return new Set(q.existingDates.all().map((r) => r.date));
    },

    /**
     * Applies validated entries from a backup.
     *   mode 'skip'      – only add dates that do not exist yet (existing dates untouched)
     *   mode 'overwrite' – dates in the backup replace the same dates here; other dates untouched
     *   mode 'replace'   – delete everything first, then load the backup
     * All-or-nothing: any failure rolls the whole restore back.
     */
    applyEntries(entries, mode) {
      if (['skip', 'overwrite', 'replace'].indexOf(mode) === -1) throw new ValidationError(['Unknown restore mode.']);
      return transaction(() => {
        const existing = mode === 'replace' ? new Set() : api.existingDates();
        if (mode === 'replace') q.delAllEntries.run();
        let added = 0, overwritten = 0, skipped = 0;
        for (const e of entries) {
          const had = existing.has(e.date);
          if (had && mode === 'skip') { skipped += 1; continue; }
          writeEntry(e);
          if (had) overwritten += 1; else added += 1;
        }
        return { added, overwritten, skipped };
      });
    },

    /** Consistent snapshot of the live database into a new file (works while the app is running). */
    snapshotTo(targetFile) {
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      db.prepare('VACUUM INTO ?').run(targetFile);
    },

    close() {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* ignore */ }
      db.close();
    }
  };

  return api;
}

module.exports = { createStore, ValidationError };
