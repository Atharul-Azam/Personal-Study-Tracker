'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../src/main/store.js');
const { createService } = require('../../src/main/service.js');
const Backup = require('../../src/main/backup.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'study-tracker-bk-'));
}

function makeService(dir) {
  const store = createStore(path.join(dir, 'study-tracker.db'));
  return { store, svc: createService(store, { dataDir: dir, appVersion: 'test', log: () => {} }) };
}

async function call(svc, method, ...args) {
  const r = await svc.invoke(method, args);
  return r;
}

const DAY1 = { date: '2026-11-01', points: [{ text: 'বাংলা নোট', done: true }, { text: 'two\nlines', done: false }], review: 'r1\nr2', durationMin: 45, status: 'completed', tags: ['a', 'b'], rating: 5 };
const DAY2 = { date: '2026-11-02', points: [{ text: 'second day' }], status: 'in_progress' };

test('JSON export → import into an empty database restores everything', async () => {
  const a = makeService(tmpDir());
  await call(a.svc, 'saveEntry', DAY1);
  await call(a.svc, 'saveEntry', DAY2);
  await call(a.svc, 'setSettings', { theme: 'dark', uiFont: 'Georgia', view: 'list', weekStart: 'mon' });
  const exp = (await call(a.svc, 'exportJson')).data;
  assert.match(exp.suggestedName, /^study-tracker-export-\d{8}-\d{6}\.json$/);

  const b = makeService(tmpDir());
  const analysis = (await call(b.svc, 'analyzeBackup', exp.text)).data;
  assert.equal(analysis.ok, true);
  assert.deepEqual([analysis.summary.entries, analysis.summary.points, analysis.summary.overlapping, analysis.summary.newDates], [2, 3, 0, 2]);
  const res = (await call(b.svc, 'applyBackup', analysis.token, 'skip', true)).data;
  assert.deepEqual([res.added, res.overwritten, res.skipped], [2, 0, 0]);
  assert.equal(res.safetyBackup, null, 'empty target needs no safety backup');

  assert.deepEqual(b.store.getEntry('2026-11-01'), a.store.getEntry('2026-11-01'));
  assert.deepEqual(b.store.getEntry('2026-11-02'), a.store.getEntry('2026-11-02'));
  const st = b.store.getSettings();
  assert.deepEqual([st.theme, st.uiFont, st.view, st.weekStart], ['dark', 'Georgia', 'list', 'mon']);
});

test('restore never silently overwrites: "skip" keeps existing days untouched', async () => {
  const a = makeService(tmpDir());
  await call(a.svc, 'saveEntry', DAY1);
  const exp = (await call(a.svc, 'exportJson')).data;

  const b = makeService(tmpDir());
  await call(b.svc, 'saveEntry', Object.assign({}, DAY1, { review: 'MY NEWER TEXT' }));
  const analysis = (await call(b.svc, 'analyzeBackup', exp.text)).data;
  assert.equal(analysis.summary.overlapping, 1);
  const res = (await call(b.svc, 'applyBackup', analysis.token, 'skip', false)).data;
  assert.deepEqual([res.added, res.overwritten, res.skipped], [0, 0, 1]);
  assert.equal(b.store.getEntry('2026-11-01').review, 'MY NEWER TEXT');
});

test('restore "overwrite" replaces only the dates in the backup and takes a safety backup first', async () => {
  const dirB = tmpDir();
  const a = makeService(tmpDir());
  await call(a.svc, 'saveEntry', DAY1);
  const exp = (await call(a.svc, 'exportJson')).data;

  const b = makeService(dirB);
  await call(b.svc, 'saveEntry', Object.assign({}, DAY1, { review: 'will be replaced' }));
  await call(b.svc, 'saveEntry', { date: '2026-12-25', points: [{ text: 'untouched day' }] });
  const analysis = (await call(b.svc, 'analyzeBackup', exp.text)).data;
  const res = (await call(b.svc, 'applyBackup', analysis.token, 'overwrite', false)).data;
  assert.deepEqual([res.added, res.overwritten, res.skipped], [0, 1, 0]);
  assert.equal(b.store.getEntry('2026-11-01').review, 'r1\nr2');
  assert.equal(b.store.getEntry('2026-12-25').points[0].text, 'untouched day');

  assert.ok(res.safetyBackup && fs.existsSync(res.safetyBackup), 'safety backup file exists');
  const snap = createStore(res.safetyBackup);
  assert.equal(snap.getEntry('2026-11-01').review, 'will be replaced', 'safety backup holds the pre-restore state');
  snap.close();
});

test('restore "replace" wipes other days only after a safety backup exists', async () => {
  const a = makeService(tmpDir());
  await call(a.svc, 'saveEntry', DAY1);
  const exp = (await call(a.svc, 'exportJson')).data;

  const b = makeService(tmpDir());
  await call(b.svc, 'saveEntry', { date: '2026-12-25', points: [{ text: 'old day' }] });
  const analysis = (await call(b.svc, 'analyzeBackup', exp.text)).data;
  const res = (await call(b.svc, 'applyBackup', analysis.token, 'replace', false)).data;
  assert.equal(b.store.counts().entries, 1);
  assert.equal(b.store.getEntry('2026-12-25').points.length, 0);
  const snap = createStore(res.safetyBackup);
  assert.equal(snap.getEntry('2026-12-25').points[0].text, 'old day');
  snap.close();
});

test('settings are only restored when the user asks for it', async () => {
  const a = makeService(tmpDir());
  await call(a.svc, 'saveEntry', DAY1);
  await call(a.svc, 'setSettings', { theme: 'dark' });
  const exp = (await call(a.svc, 'exportJson')).data;
  const b = makeService(tmpDir());
  await call(b.svc, 'setSettings', { theme: 'light' });
  const an = (await call(b.svc, 'analyzeBackup', exp.text)).data;
  await call(b.svc, 'applyBackup', an.token, 'skip', false);
  assert.equal(b.store.getSettings().theme, 'light');
});

test('invalid and corrupted backup files are rejected with friendly messages and change nothing', async () => {
  const { store, svc } = makeService(tmpDir());
  await call(svc, 'saveEntry', DAY1);
  const good = JSON.parse((await call(svc, 'exportJson')).data.text);

  const cases = {
    'not json': 'this is not json {',
    'truncated json': JSON.stringify(good).slice(0, 60),
    'empty file': '',
    'json array': '[1,2,3]',
    'json null': 'null',
    'wrong app': JSON.stringify(Object.assign({}, good, { app: 'something-else' })),
    'no version': JSON.stringify(Object.assign({}, good, { formatVersion: undefined })),
    'future version': JSON.stringify(Object.assign({}, good, { formatVersion: 99 })),
    'entries not a list': JSON.stringify(Object.assign({}, good, { entries: {} })),
    'impossible date': JSON.stringify(Object.assign({}, good, { entries: [Object.assign({}, good.entries[0], { date: '2026-02-30' })] })),
    'bad status': JSON.stringify(Object.assign({}, good, { entries: [Object.assign({}, good.entries[0], { status: 'finished' })] })),
    'bad rating': JSON.stringify(Object.assign({}, good, { entries: [Object.assign({}, good.entries[0], { rating: 11 })] })),
    'points wrong type': JSON.stringify(Object.assign({}, good, { entries: [Object.assign({}, good.entries[0], { points: 'x' })] })),
    'duplicate dates': JSON.stringify(Object.assign({}, good, { entries: [good.entries[0], good.entries[0]] })),
    'one good one bad': JSON.stringify(Object.assign({}, good, { entries: [good.entries[0], { date: 'nope' }] }))
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = (await call(svc, 'analyzeBackup', text)).data;
    assert.equal(r.ok, false, name);
    assert.ok(r.errors.length > 0 && r.errors.every((e) => typeof e === 'string' && !/Error:|\bat .*:\d+/.test(e)), name + ': friendly errors');
  }
  assert.deepEqual(store.getEntry('2026-11-01').points.length, 2, 'nothing changed');
  assert.equal(store.counts().entries, 1);
});

test('applyBackup with an unknown/expired token fails safely', async () => {
  const { store, svc } = makeService(tmpDir());
  await call(svc, 'saveEntry', DAY1);
  const r = await call(svc, 'applyBackup', 'bogus-token', 'replace', true);
  assert.equal(r.ok, false);
  assert.equal(store.counts().entries, 1);
});

test('a restore is all-or-nothing: a backup with a single bad entry is rejected as a whole', async () => {
  const { store, svc } = makeService(tmpDir());
  const doc = { app: 'study-tracker', formatVersion: 1, entries: [DAY1, { date: '2026-11-31' }] };
  const r = (await call(svc, 'analyzeBackup', JSON.stringify(doc))).data;
  assert.equal(r.ok, false);
  assert.equal(store.counts().entries, 0);
});

test('a backup with a UTF-8 BOM still imports', () => {
  const text = '﻿' + JSON.stringify({ app: 'study-tracker', formatVersion: 1, entries: [DAY1] });
  assert.equal(Backup.parseBackup(text).ok, true);
});

test('createBackup writes a standalone, openable copy of the live database', async () => {
  const dir = tmpDir();
  const { svc } = makeService(dir);
  await call(svc, 'saveEntry', DAY1);
  const r = (await call(svc, 'createBackup')).data;
  assert.ok(r.file.startsWith(path.join(dir, 'backups')));
  assert.ok(fs.statSync(r.file).size > 0);
  const copy = createStore(r.file);
  assert.deepEqual(copy.getEntry('2026-11-01'), createStore(path.join(dir, 'study-tracker.db')).getEntry('2026-11-01'));
  copy.close();
  // creating a second backup in the same second must not overwrite the first
  const r2 = (await call(svc, 'createBackup')).data;
  assert.notEqual(r2.file, r.file);
  assert.ok(fs.existsSync(r.file) && fs.existsSync(r2.file));
});

test('CSV export is readable, escaped, BOM-prefixed and guards against formula injection', async () => {
  const { svc } = makeService(tmpDir());
  await call(svc, 'saveEntry', { date: '2026-11-03', points: [{ text: 'say "hi", ok' }, { text: '=HYPERLINK("x")' }], tags: ['=cmd|calc'], durationMin: 20, status: 'completed', review: 'x' });
  await call(svc, 'saveEntry', { date: '2026-11-01', points: [{ text: 'বাংলা' }] });
  const csv = (await call(svc, 'exportCsv')).data.text;
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0], 'date,weekday,status,duration_minutes,learning_points,points_done,rating,tags,has_review,learning_log');
  assert.equal(lines.length, 3, 'header + 2 days, sorted by date');
  assert.ok(lines[1].startsWith('2026-11-01,Sunday,Not started,,1,0,,'));
  assert.ok(lines[1].includes('বাংলা'));
  // the log cell starts with "1." so it is not a formula; quotes/commas are escaped per RFC 4180
  assert.ok(lines[2].includes('"1. say ""hi"", ok | 2. =HYPERLINK(""x"")"'), lines[2]);
  // a free-text cell that WOULD start with = is neutralised with a leading apostrophe
  assert.ok(lines[2].includes(",'=cmd|calc,"), lines[2]);
  assert.ok(lines[2].includes(',Completed,20,2,0,'));
  assert.equal(Backup.csvCell('+1', true), "'+1");
  assert.equal(Backup.csvCell('-1', true), "'-1");
  assert.equal(Backup.csvCell('@x', true), "'@x");
  assert.equal(Backup.csvCell(-5), '-5', 'plain numbers are not altered');
});

test('invoke never throws and never leaks stack traces', async () => {
  const { svc } = makeService(tmpDir());
  for (const [m, args] of [['nope', []], ['saveEntry', [null]], ['getEntry', ['x']], ['getMonth', [2026, 99]], ['setSettings', [undefined]]]) {
    const r = await svc.invoke(m, args);
    if (!r.ok) assert.ok(typeof r.message === 'string' && !/\bat .*:\d+/.test(r.message), m);
  }
});
