'use strict';
/*
 * SQLite bootstrap + schema migrations.
 *
 * Uses the SQLite engine built into Node/Electron (`node:sqlite`), so there is
 * no native module to compile and nothing extra to ship.
 *
 * Schema versioning uses PRAGMA user_version. To change the schema later, append
 * a function to MIGRATIONS; it runs once, inside a transaction, and a copy of the
 * old database file is kept next to it before any migration touches it.
 */
const fs = require('node:fs');
const path = require('node:path');

class DatabaseInitError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'DatabaseInitError';
    this.cause = cause;
  }
}

const MIGRATIONS = [
  // v1: initial schema
  function v1(db) {
    db.exec(`
      CREATE TABLE entries (
        date         TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        review       TEXT NOT NULL DEFAULT '',
        duration_min INTEGER CHECK (duration_min IS NULL OR duration_min >= 0),
        status       TEXT NOT NULL DEFAULT 'not_started'
                     CHECK (status IN ('not_started','in_progress','completed')),
        tags         TEXT NOT NULL DEFAULT '[]',
        rating       INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE TABLE points (
        date     TEXT NOT NULL REFERENCES entries(date) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text     TEXT NOT NULL,
        done     INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
        PRIMARY KEY (date, position)
      ) WITHOUT ROWID;
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }
];

const LATEST_VERSION = MIGRATIONS.length;

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (err) {
    throw new DatabaseInitError(
      'This build of the app does not include the built-in SQLite engine, so your data cannot be opened.',
      err
    );
  }
}

function getVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function migrate(db, file) {
  const current = getVersion(db);
  if (current > LATEST_VERSION) {
    throw new DatabaseInitError(
      'Your study data was created by a newer version of Study Tracker (data version ' + current +
      ', this app understands up to ' + LATEST_VERSION + '). Please update the app. Nothing was changed.'
    );
  }
  if (current === LATEST_VERSION) return;

  // Keep a copy of an existing (non-empty) database before changing its structure.
  if (current > 0 && file && file !== ':memory:') {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(file, file + '.before-v' + LATEST_VERSION + '.bak');
    } catch (err) {
      throw new DatabaseInitError('Could not make a safety copy of your data before updating it. Nothing was changed.', err);
    }
  }

  for (let v = current; v < LATEST_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[v](db);
      db.exec('PRAGMA user_version = ' + (v + 1));
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw new DatabaseInitError('Updating the data format failed. Your data was left unchanged.', err);
    }
  }
}

/** Opens (creating if necessary) the database at `file`. Pass ':memory:' for tests. */
function openDatabase(file) {
  const { DatabaseSync } = loadSqlite();
  const damaged = () => new DatabaseInitError(
    'The study database file looks damaged. It has not been modified or deleted: ' + file +
    ' — restore from a backup, or move that file away to start fresh.'
  );
  let db;
  try {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 3000');

    // Read-only checks first: nothing below may write to a file we are going to refuse.
    if (file !== ':memory:') {
      const check = db.prepare('PRAGMA quick_check').get();
      if ((check && Object.values(check)[0]) !== 'ok') throw damaged();
    }
    const version = getVersion(db);
    if (version > LATEST_VERSION) {
      throw new DatabaseInitError(
        'Your study data was created by a newer version of Study Tracker (data version ' + version +
        ', this app understands up to ' + LATEST_VERSION + '). Please update the app. Nothing was changed.'
      );
    }

    db.exec('PRAGMA foreign_keys = ON');
    if (file !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    migrate(db, file);
    return db;
  } catch (err) {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
    if (err instanceof DatabaseInitError) throw err;
    if (/not a database|malformed|corrupt/i.test(String(err && err.message))) throw damaged();
    throw new DatabaseInitError(
      'Study Tracker could not open its data file (' + file + '). Check that the folder is writable and the disk is not full.',
      err
    );
  }
}

module.exports = { openDatabase, DatabaseInitError, LATEST_VERSION, MIGRATIONS };
