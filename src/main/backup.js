'use strict';
/*
 * Backup / restore helpers: JSON export + strict validation of imports, CSV export.
 * Nothing here touches the disk or Electron; the service layer does that.
 */
const Dates = require('../shared/dates.js');
const Model = require('../shared/model.js');

const APP_ID = 'study-tracker';
const FORMAT_VERSION = 1;
const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
const MAX_REPORTED_ERRORS = 15;

function buildExport(entries, settings, now) {
  return {
    app: APP_ID,
    formatVersion: FORMAT_VERSION,
    exportedAt: (now || new Date()).toISOString(),
    settings: settings,
    entries: entries.map((e) => ({
      date: e.date,
      points: e.points.map((p) => ({ text: p.text, done: !!p.done })),
      review: e.review,
      durationMin: e.durationMin,
      status: e.status,
      tags: e.tags,
      rating: e.rating
    }))
  };
}

/**
 * Parses and validates backup text. Never throws.
 * Returns { ok:true, entries, settings, exportedAt } or { ok:false, errors:[friendly strings] }.
 * A backup is accepted only if EVERY entry is valid, so a restore is all-or-nothing.
 */
function parseBackup(text) {
  if (typeof text !== 'string') return { ok: false, errors: ['The file could not be read as text.'] };
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, errors: ['The file is too large to be a Study Tracker backup.'] };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return { ok: false, errors: ['This file is not valid JSON, so it cannot be a Study Tracker backup (it may be damaged or incomplete).'] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['This file does not look like a Study Tracker backup.'] };
  }
  if (data.app !== APP_ID) {
    return { ok: false, errors: ['This file was not created by Study Tracker (missing app marker).'] };
  }
  if (!Number.isInteger(data.formatVersion) || data.formatVersion < 1) {
    return { ok: false, errors: ['The backup has no valid format version.'] };
  }
  if (data.formatVersion > FORMAT_VERSION) {
    return { ok: false, errors: ['This backup was made by a newer version of Study Tracker (format ' + data.formatVersion + '). Please update the app first.'] };
  }
  if (!Array.isArray(data.entries)) {
    return { ok: false, errors: ['The backup does not contain a list of entries.'] };
  }

  const errors = [];
  const entries = [];
  const seen = new Set();
  data.entries.forEach((raw, i) => {
    const v = Model.validateEntry(raw);
    const label = 'Entry ' + (i + 1) + (raw && typeof raw.date === 'string' ? ' (' + raw.date + ')' : '');
    if (!v.ok) {
      v.errors.forEach((msg) => errors.push(label + ': ' + msg));
      return;
    }
    if (seen.has(v.entry.date)) { errors.push(label + ': the date appears more than once in this backup.'); return; }
    seen.add(v.entry.date);
    entries.push(v.entry);
  });

  if (errors.length) {
    const shown = errors.slice(0, MAX_REPORTED_ERRORS);
    if (errors.length > shown.length) shown.push('…and ' + (errors.length - shown.length) + ' more problem(s).');
    return { ok: false, errors: shown };
  }

  let settings = null;
  if (data.settings !== undefined && data.settings !== null) {
    if (typeof data.settings !== 'object' || Array.isArray(data.settings)) {
      return { ok: false, errors: ['The backup\'s settings section is not valid.'] };
    }
    settings = Model.sanitizeSettings(data.settings);
  }

  return { ok: true, entries, settings, exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null };
}

// ---- CSV ------------------------------------------------------------------

function csvCell(value, isText) {
  let s = value === null || value === undefined ? '' : String(value);
  // Spreadsheet formula injection guard for free-text columns.
  if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const CSV_HEADER = ['date', 'weekday', 'status', 'duration_minutes', 'learning_points', 'points_done', 'rating', 'tags', 'has_review', 'learning_log'];

/** Readable summary export (one row per date). UTF-8 with BOM so Excel shows Bangla correctly. */
function buildCsv(entries) {
  const rows = [CSV_HEADER.join(',')];
  entries.forEach((e) => {
    const wd = Dates.weekdayOfISO(e.date);
    rows.push([
      csvCell(e.date),
      csvCell(wd === null ? '' : Dates.WEEKDAY_NAMES[wd]),
      csvCell(Model.STATUS_LABELS[e.status] || e.status),
      csvCell(e.durationMin),
      csvCell(e.points.length),
      csvCell(e.points.filter((p) => p.done).length),
      csvCell(e.rating),
      csvCell(e.tags.join('; '), true),
      csvCell(e.review ? 'yes' : 'no'),
      csvCell(e.points.map((p, i) => (i + 1) + '. ' + p.text.replace(/\s*\n\s*/g, ' ')).join(' | '), true)
    ].join(','));
  });
  return '﻿' + rows.join('\r\n') + '\r\n';
}

module.exports = { APP_ID, FORMAT_VERSION, buildExport, parseBackup, buildCsv, csvCell };
