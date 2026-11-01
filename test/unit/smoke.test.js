'use strict';
/*
 * The smoke test is what CI uses to prove the REAL Electron app works. A previous CI run failed with
 * "smoke-dev.json does not exist" because the app hung and nothing explained why. These tests pin down
 * the guarantee that the smoke run always leaves an explanatory report, whatever goes wrong.
 * (They use fakes: whether real Electron passes can only be known by running it.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const Smoke = require('../../src/main/smoke.js');
const Dates = require('../../src/shared/dates.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'study-tracker-smoke-test-'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('report: written immediately, rewritten on every stage/check/log, and records failures', () => {
  const f = path.join(tmp, 'r1.json');
  const r = Smoke.createReport(f, { platform: 'test' });
  assert.equal(readJson(f).stage, 'starting', 'exists before anything has run');
  r.stage('step one');
  assert.equal(readJson(f).stage, 'step one');
  r.check('good', true); r.check('bad', false, 'why');
  const j = readJson(f);
  assert.deepEqual(j.checks.map((c) => [c.name, c.pass]), [['good', true], ['bad', false]]);
  assert.ok(j.log.some((l) => /CHECK FAILED: bad \(why\)/.test(l)));
  assert.equal(j.platform, 'test');
  r.log('x'.repeat(5000));
  assert.ok(readJson(f).log.at(-1).length < 900, 'long lines are truncated');
  for (let i = 0; i < 1000; i++) r.log('spam ' + i);
  assert.ok(readJson(f).log.length <= 300, 'log is bounded');
  assert.equal(r.finish(true).ok, true);
  assert.doesNotThrow(() => Smoke.createReport(path.join(tmp, 'no-such-dir', 'x.json'), {}).stage('unwritable path must not throw'));
});

test('withTimeout rejects with a descriptive message and clears its timer', async () => {
  await assert.rejects(Smoke.withTimeout(new Promise(() => {}), 30, 'waiting for foo'), /timed out after 30 ms: waiting for foo/);
  assert.equal(await Smoke.withTimeout(Promise.resolve(7), 1000, 'x'), 7);
});

// --- a scripted fake renderer for Smoke.run ---------------------------------------------------
function fakeWc(script) {
  const wc = new EventEmitter();
  wc.loading = !!script.loading;
  wc.isLoading = () => wc.loading;
  wc.reloads = 0;
  wc.reload = () => { wc.reloads++; setImmediate(() => wc.emit('did-finish-load')); };
  wc.executeJavaScript = (code) => script.handle(code, wc);
  return wc;
}
function happyHandler(over) {
  const now = Dates.todayParts();
  const days = Dates.daysInMonth(now.year, now.month);
  return (code, wc) => {
    if (over && over.before) { const r = over.before(code, wc); if (r !== undefined) return r; }
    if (/readyState/.test(code) && /typeof window\.__appReady/.test(code) && !/title:/.test(code)) return Promise.resolve({ href: 'file:///x', readyState: 'complete', api: 'object', appReady: 'object' });
    if (code.trim() === 'window.__appReady') return Promise.resolve(true);
    if (/querySelectorAll\('\.day\[data-date\]'\)/.test(code)) return Promise.resolve({ days, allInMonth: true, title: Dates.MONTH_NAMES[now.month - 1] + ' ' + now.year, hasApi: true });
    if (/saveEntry/.test(code)) return Promise.resolve({ ok: true });
    if (/fetch\(/.test(code)) return Promise.resolve('BLOCKED');
    if (/classList\.contains\('has-notes'\)/.test(code)) return Promise.resolve({ hasNotes: true, text: 'smoke test ✓ বাংলা', points: 'smoke test ✓ বাংলা' });
    return Promise.resolve(null);
  };
}
const FAST = { step: 400, load: 600, ready: 600, probe: 200 };
function ctxFor(wc, name) {
  const file = path.join(tmp, name + '.json');
  const report = Smoke.createReport(file, {});
  let closed = 0;
  const entry = { points: [{ text: 'smoke test ✓ বাংলা' }], review: 'persisted' };
  return { file, report, ctx: { wc, report, Dates, userData: tmp, dbFile: path.join(tmp, 'x.db'), closeStore: () => { closed++; }, openStore: () => ({ getEntry: () => entry, close() {} }), timeouts: FAST }, closed: () => closed };
}

test('run: a healthy renderer passes every check and the report says so', async () => {
  const wc = fakeWc({ handle: happyHandler() });
  const c = ctxFor(wc, 'happy');
  assert.equal(await Smoke.run(c.ctx), true);
  const j = readJson(c.file);
  assert.ok(j.checks.length >= 8 && j.checks.every((x) => x.pass), JSON.stringify(j.checks.filter((x) => !x.pass)));
  assert.equal(wc.reloads, 1);
  assert.equal(c.closed(), 1);
  assert.match(j.stage, /all checks passed/);
});

test('run: a failing check makes it fail (and says which)', async () => {
  const wc = fakeWc({ handle: happyHandler({ before: (code) => (/fetch\(/.test(code) ? Promise.resolve('REACHED') : undefined) }) });
  const c = ctxFor(wc, 'net');
  assert.equal(await Smoke.run(c.ctx), false);
  const bad = readJson(c.file).checks.filter((x) => !x.pass);
  assert.deepEqual(bad.map((x) => x.name), ['network requests are blocked (offline-only)']);
});

test('run: the page never defines __appReady (scripts did not run) → fails fast with the probe in the report, no hang', async () => {
  const wc = fakeWc({ handle: (code) => (/readyState/.test(code) && !/title:/.test(code) ? Promise.resolve({ href: 'file:///x', readyState: 'complete', api: 'undefined', appReady: 'undefined' }) : Promise.resolve({ title: '', text: 'blank' })) });
  const c = ctxFor(wc, 'noready');
  const t0 = Date.now();
  assert.equal(await Smoke.run(c.ctx), false);
  assert.ok(Date.now() - t0 < 3000);
  const j = readJson(c.file);
  assert.match(j.checks.at(-1).detail, /never defined window\.__appReady/);
  assert.match(j.checks.at(-1).name, /failed at stage "start-up: waiting for the page scripts"/);
  assert.ok(j.log.some((l) => /WARNING: window\.api is undefined/.test(l)));
  assert.ok(j.snapshot, 'failure snapshot captured');
});

test('run: the app reports a start-up failure → the on-screen error text is put in the report', async () => {
  const wc = fakeWc({ handle: happyHandler({ before: (code) => {
    if (code.trim() === 'window.__appReady') return Promise.resolve(false);
    if (/getElementById\('calendar'\)/.test(code)) return Promise.resolve('Study Tracker could not start\nThe connection to the application core is missing');
  } }) });
  const c = ctxFor(wc, 'fatal');
  assert.equal(await Smoke.run(c.ctx), false);
  assert.match(readJson(c.file).checks.at(-1).detail, /could not start The connection to the application core is missing/);
});

test('run: a renderer that never answers times out per step instead of hanging', async () => {
  const wc = fakeWc({ handle: () => new Promise(() => {}) });
  const c = ctxFor(wc, 'silent');
  const t0 = Date.now();
  assert.equal(await Smoke.run(c.ctx), false);
  assert.ok(Date.now() - t0 < 5000, 'finished in ' + (Date.now() - t0) + ' ms');
  const j = readJson(c.file);
  assert.ok(j.checks.some((x) => !x.pass));
  assert.deepEqual(j.snapshot && Object.keys(j.snapshot), ['unavailable']);
});

test('run: a page that fails to load is reported with the Chromium error', async () => {
  const wc = fakeWc({ loading: true, handle: happyHandler() });
  const c = ctxFor(wc, 'loadfail');
  setTimeout(() => wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x/index.html'), 20);
  assert.equal(await Smoke.run(c.ctx), false);
  assert.match(readJson(c.file).checks.at(-1).detail, /ERR_FILE_NOT_FOUND/);
});

test('run: data missing from the database file after reopening is a failed check', async () => {
  const wc = fakeWc({ handle: happyHandler() });
  const c = ctxFor(wc, 'nodata');
  c.ctx.openStore = () => ({ getEntry: () => ({ points: [], review: '' }), close() {} });
  assert.equal(await Smoke.run(c.ctx), false);
  assert.ok(readJson(c.file).checks.some((x) => !x.pass && /on disk/.test(x.name)));
});

// --- main.js in --smoke-test mode, in a child process, against a fake Electron ---------------------
function runMain(name, env, prep) {
  const base = fs.mkdtempSync(path.join(tmp, name + '-'));
  if (prep) prep(base);
  const out = path.join(base, 'report.json');
  const r = spawnSync(process.execPath, ['--no-warnings', '--require', path.join(__dirname, 'fixtures', 'fake-electron-smoke.js'),
    path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), '--smoke-test', '--smoke-out=' + out],
  { env: Object.assign({}, process.env, { FAKE_BASE: base }, env), encoding: 'utf8', timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report: fs.existsSync(out) ? readJson(out) : null, out };
}

test('main.js --smoke-test: if the window never loads, the watchdog still writes a report naming the stage, and exits non-zero', () => {
  const r = runMain('watchdog', { FAKE_RENDERER: 'never-loads', STUDY_TRACKER_SMOKE_TIMEOUT_MS: '1500' });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.report, 'report file exists');
  assert.equal(r.report.ok, false);
  assert.match(r.report.checks.at(-1).name, /finished within .* s \(stuck at stage "(initial page load|waiting for the window to load)"\)/);
  assert.ok(r.report.log.some((l) => /stage: window created/.test(l)));
  assert.match(r.stdout, /"ok": false/, 'the report is also printed to the console');
});

test('main.js --smoke-test: a page whose scripts never run fails fast with a clear report (exit 1)', () => {
  const r = runMain('noappready', { FAKE_RENDERER: 'no-appready' });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.report.checks.at(-1).detail, /never defined window\.__appReady/);
});

test('main.js --smoke-test: an app that cannot start reports the on-screen error (exit 1)', () => {
  const r = runMain('fatal', { FAKE_RENDERER: 'ok-fatal' });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.report.checks.at(-1).detail, /could not start/);
});
