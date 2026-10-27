'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, ValidationError } = require('../../src/main/store.js');
const { openDatabase, DatabaseInitError, LATEST_VERSION } = require('../../src/main/db.js');
const Model = require('../../src/shared/model.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'study-tracker-test-'));
}

const BANGLA = 'আজকে পয়েন্টার শিখলাম — C++ নোট';

function sample(date, extra) {
  return Object.assign({
    date,
    points: [{ text: 'GitHub Tutorial', done: false }, { text: 'C++ Pointers', done: true }, { text: 'DSA — Linked Lists', done: false }],
    review: 'Understood pointers.\nStill confused about references.\n\nRevise tomorrow.',
    durationMin: 90,
    status: 'in_progress',
    tags: ['cpp', 'dsa'],
    rating: 4
  }, extra);
}

test('a date with nothing saved returns a blank entry and stores nothing', () => {
  const s = createStore(':memory:');
  assert.deepEqual(s.getEntry('2026-11-05'), Model.blankEntry('2026-11-05'));
  assert.deepEqual(s.counts(), { entries: 0, points: 0 });
});

test('save and reload restores every field, including line breaks, order and Bangla text', () => {
  const s = createStore(':memory:');
  const e = sample('2026-11-05', { points: [{ text: 'প্রথম', done: false }, { text: BANGLA + '\nsecond line', done: true }, { text: 'https://example.com/ref (offline note)', done: false }] });
  s.saveEntry(e);
  const back = s.getEntry('2026-11-05');
  assert.deepEqual(back, e);
});

test('every date has an independent journal; saving one never changes another', () => {
  const s = createStore(':memory:');
  s.saveEntry(sample('2026-11-05'));
  s.saveEntry(sample('2026-11-06', { points: [{ text: 'Only item', done: false }], review: 'other day', durationMin: 10, status: 'completed', tags: [], rating: null }));
  const a = s.getEntry('2026-11-05');
  s.saveEntry(sample('2026-11-06', { review: 'edited the other day' }));
  assert.deepEqual(s.getEntry('2026-11-05'), a, 'unchanged');
  assert.equal(s.getEntry('2026-11-06').review, 'edited the other day');
  assert.equal(s.getEntry('2026-11-04').points.length, 0);
});

test('learning points: add, edit, delete, reorder', () => {
  const s = createStore(':memory:');
  const date = '2026-03-10';
  s.saveEntry({ date, points: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] });
  assert.deepEqual(s.getEntry(date).points.map((p) => p.text), ['A', 'B', 'C']);

  s.saveEntry({ date, points: [{ text: 'A' }, { text: 'B edited' }, { text: 'C' }, { text: 'D' }] });
  assert.deepEqual(s.getEntry(date).points.map((p) => p.text), ['A', 'B edited', 'C', 'D']);

  s.saveEntry({ date, points: [{ text: 'A' }, { text: 'C' }, { text: 'D' }] });
  assert.deepEqual(s.getEntry(date).points.map((p) => p.text), ['A', 'C', 'D']);

  s.saveEntry({ date, points: [{ text: 'D' }, { text: 'A' }, { text: 'C' }] });
  assert.deepEqual(s.getEntry(date).points.map((p) => p.text), ['D', 'A', 'C']);
  assert.equal(s.counts().points, 3, 'no orphan or duplicate rows after repeated saves');
});

test('blank learning points are dropped; a fully empty day is removed from the database', () => {
  const s = createStore(':memory:');
  s.saveEntry({ date: '2026-01-02', points: [{ text: '  ' }, { text: 'real' }, { text: '' }] });
  assert.deepEqual(s.getEntry('2026-01-02').points.map((p) => p.text), ['real']);
  s.saveEntry({ date: '2026-01-02', points: [{ text: '   ' }], review: '   \n ', status: 'not_started' });
  assert.deepEqual(s.counts(), { entries: 0, points: 0 });
});

test('personal review keeps its exact text (line breaks, indentation, trailing spaces)', () => {
  const s = createStore(':memory:');
  const review = 'Line 1\n  indented\n\nLine 4 with trailing  ';
  s.saveEntry({ date: '2026-05-05', review });
  assert.equal(s.getEntry('2026-05-05').review, review);
});

test('validation rejects bad dates, statuses, ratings, durations and does not write anything', () => {
  const s = createStore(':memory:');
  const bad = [
    { date: '2026-02-30' },
    { date: '2026-13-01' },
    { date: 'tomorrow' },
    { date: '2026-05-05', status: 'done' },
    { date: '2026-05-05', rating: 6 },
    { date: '2026-05-05', rating: 0 },
    { date: '2026-05-05', durationMin: -5 },
    { date: '2026-05-05', durationMin: 1.5 },
    { date: '2026-05-05', durationMin: 999999999 },
    { date: '2026-05-05', points: 'not a list' },
    { date: '2026-05-05', points: [{ text: 5 }] },
    { date: '2026-05-05', tags: 'x' },
    null,
    'string'
  ];
  for (const b of bad) assert.throws(() => s.saveEntry(b), ValidationError, JSON.stringify(b));
  assert.deepEqual(s.counts(), { entries: 0, points: 0 });
});

test('a failed save leaves the previously saved day untouched (atomic)', () => {
  const s = createStore(':memory:');
  s.saveEntry(sample('2026-06-06'));
  const before = s.getEntry('2026-06-06');
  assert.throws(() => s.saveEntry(sample('2026-06-06', { rating: 99 })), ValidationError);
  assert.deepEqual(s.getEntry('2026-06-06'), before);
});

test('leap day and year boundaries store and read back correctly', () => {
  const s = createStore(':memory:');
  for (const d of ['2024-02-29', '2025-12-31', '2026-01-01']) s.saveEntry({ date: d, points: [{ text: d }] });
  assert.equal(s.getEntry('2024-02-29').points[0].text, '2024-02-29');
  assert.throws(() => s.saveEntry({ date: '2025-02-29', points: [{ text: 'x' }] }), ValidationError);
  assert.equal(s.getMonth(2024, 2).stats.learningPoints, 1);
  assert.equal(s.getMonth(2025, 12).days['2025-12-31'].points, 1);
  assert.equal(s.getMonth(2026, 1).days['2025-12-31'], undefined, 'December entry does not leak into January');
});

test('getMonth returns only that month, with correct summaries', () => {
  const s = createStore(':memory:');
  s.saveEntry(sample('2026-10-31'));
  s.saveEntry(sample('2026-11-01', { status: 'completed', durationMin: 60 }));
  s.saveEntry(sample('2026-11-30', { points: [{ text: 'x', done: true }], review: '', status: 'not_started', durationMin: null, tags: [], rating: null }));
  s.saveEntry(sample('2026-12-01'));
  const m = s.getMonth(2026, 11);
  assert.deepEqual(Object.keys(m.days).sort(), ['2026-11-01', '2026-11-30']);
  assert.equal(m.days['2026-11-01'].points, 3);
  assert.deepEqual(m.days['2026-11-01'].firstPoints, ['GitHub Tutorial', 'C++ Pointers', 'DSA — Linked Lists']);
  assert.equal(m.days['2026-11-01'].review, true);
  assert.equal(m.days['2026-11-30'].review, false);
  assert.throws(() => s.getMonth(2026, 13), ValidationError);
});

test('monthly statistics follow the documented rules', () => {
  const s = createStore(':memory:');
  s.saveEntry({ date: '2026-11-01', points: [{ text: 'a' }, { text: 'b' }], status: 'completed', durationMin: 60, review: 'r' });
  s.saveEntry({ date: '2026-11-02', points: [{ text: 'c' }], status: 'in_progress', durationMin: 30 });
  s.saveEntry({ date: '2026-11-03', points: [{ text: 'd' }] }); // notes but no status: still a study day, not completed
  s.saveEntry({ date: '2026-11-04', review: 'only a reflection' }); // not a study day by the rule
  s.saveEntry({ date: '2026-11-05', durationMin: 15 }); // duration alone counts
  s.saveEntry({ date: '2026-10-31', points: [{ text: 'other month' }], status: 'completed', durationMin: 500 });
  const { stats } = s.getMonth(2026, 11);
  assert.deepEqual(stats, { studyDays: 4, completedDays: 1, learningPoints: 4, reviewDays: 2, totalMinutes: 105, daysWithDuration: 3 });
});

test('merely reading a day (opening it) never creates a record or marks it completed', () => {
  const s = createStore(':memory:');
  s.getEntry('2026-11-09');
  s.getEntry('2026-11-10');
  assert.deepEqual(s.counts(), { entries: 0, points: 0 });
  assert.deepEqual(s.getMonth(2026, 11).stats.completedDays, 0);
});

test('settings: defaults, validation, persistence of partial updates', () => {
  const s = createStore(':memory:');
  assert.deepEqual(s.getSettings(), Model.DEFAULT_SETTINGS);
  const r = s.setSettings({ theme: 'dark', uiFontSize: 18, view: 'list', weekStart: 'sat', editorFont: 'Georgia', autosave: false });
  assert.equal(r.theme, 'dark');
  assert.equal(r.uiFontSize, 18);
  assert.equal(r.view, 'list');
  assert.equal(r.weekStart, 'sat');
  assert.equal(r.autosave, false);
  assert.equal(r.uiFont, 'system', 'untouched keys keep defaults');
  // invalid values are ignored / clamped, unknown keys dropped
  const r2 = s.setSettings({ theme: 'neon', uiFontSize: 500, view: 'cube', evil: 1, editorFont: 'x;{background:red}' });
  assert.equal(r2.theme, 'dark', 'invalid theme keeps previous value');
  assert.equal(r2.uiFontSize, Model.FONT_SIZE_MAX);
  assert.equal(r2.view, 'list');
  assert.equal(r2.editorFont, 'Georgia', 'unsafe font string rejected');
  assert.equal('evil' in r2, false);
});

test('data persists across closing and reopening the database file (restart)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'study.db');
  const a = createStore(file);
  a.saveEntry(sample('2026-11-05', { review: BANGLA }));
  a.saveEntry(sample('2026-11-06'));
  a.setSettings({ theme: 'dark', uiFont: 'Georgia', uiFontSize: 17, view: 'list' });
  a.close();

  const b = createStore(file);
  assert.equal(b.getEntry('2026-11-05').review, BANGLA);
  assert.equal(b.getEntry('2026-11-06').points.length, 3);
  const st = b.getSettings();
  assert.equal(st.theme, 'dark');
  assert.equal(st.uiFont, 'Georgia');
  assert.equal(st.uiFontSize, 17);
  assert.equal(st.view, 'list');
  b.close();
});

test('data survives an unclean shutdown (process never calls close)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'crash.db');
  // Simulate a crash with a child process that writes and then dies without closing.
  const { spawnSync } = require('node:child_process');
  const script = `
    const { createStore } = require(${JSON.stringify(path.join(__dirname, '../../src/main/store.js'))});
    const s = createStore(${JSON.stringify(file)});
    s.saveEntry({ date: '2026-11-05', points: [{ text: 'survives a crash' }], review: 'ok' });
    process.kill(process.pid, 'SIGKILL');
  `;
  const res = spawnSync(process.execPath, ['--no-warnings', '-e', script]);
  assert.ok(res.signal === 'SIGKILL' || res.status !== 0, 'child was killed hard');
  const s = createStore(file);
  assert.equal(s.getEntry('2026-11-05').points[0].text, 'survives a crash');
  s.close();
});

test('database schema is versioned and re-opening is idempotent', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'v.db');
  const db1 = openDatabase(file);
  assert.equal(db1.prepare('PRAGMA user_version').get().user_version, LATEST_VERSION);
  db1.close();
  const db2 = openDatabase(file);
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, LATEST_VERSION);
  db2.close();
});

test('opening a database from a NEWER app version is refused without modifying it', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'new.db');
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 999');
  raw.close();
  const before = fs.readFileSync(file);
  assert.throws(() => openDatabase(file), DatabaseInitError);
  assert.ok(before.equals(fs.readFileSync(file)), 'file untouched');
});

test('a corrupted database file gives a friendly error and is never deleted', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'broken.db');
  fs.writeFileSync(file, Buffer.from('this is definitely not a sqlite database file '.repeat(50)));
  assert.throws(() => openDatabase(file), (err) => err instanceof DatabaseInitError && !/at .*\.js:\d+/.test(err.message));
  assert.ok(fs.existsSync(file), 'user file is preserved');
});

test('an unwritable location gives a friendly initialisation error', () => {
  // Portable "cannot create the folder" case: the would-be parent folder is actually a regular file.
  const blocker = path.join(tmpDir(), 'iam-a-file');
  fs.writeFileSync(blocker, 'x');
  assert.throws(() => openDatabase(path.join(blocker, 'sub', 'study.db')), (err) => err instanceof DatabaseInitError && /could not open its data file/.test(err.message));
});

test('a damaged file is reported as damaged (not as a permissions problem)', () => {
  const file = path.join(tmpDir(), 'garbage.db');
  fs.writeFileSync(file, Buffer.from('x'.repeat(4096)));
  assert.throws(() => openDatabase(file), (err) => err instanceof DatabaseInitError && /looks damaged/.test(err.message));
});

test('large data set: 3 years of daily entries load per month quickly', () => {
  const s = createStore(':memory:');
  const t0 = Date.now();
  let n = 0;
  for (let y = 2024; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 28; d++) {
        const date = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        s.saveEntry({ date, points: [{ text: 'a' + n }, { text: 'b' }, { text: 'c' }], review: 'x'.repeat(200), durationMin: 30, status: 'completed' });
        n++;
      }
    }
  }
  const t1 = Date.now();
  for (let i = 0; i < 100; i++) s.getMonth(2025, 6);
  const perMonthMs = (Date.now() - t1) / 100;
  assert.equal(s.counts().entries, n);
  assert.ok(perMonthMs < 25, 'getMonth took ' + perMonthMs + 'ms');
  assert.ok(t1 - t0 < 20000, 'bulk write took ' + (t1 - t0) + 'ms');
});
