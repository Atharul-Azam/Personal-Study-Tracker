'use strict';
/*
 * Logic behind `--smoke-test` (kept free of Electron imports so it can be unit-tested).
 *
 * Design rule: a smoke run must ALWAYS leave behind a report that says what happened, even if
 * the app hangs, crashes or never gets as far as opening a window. So the report file is
 * rewritten at every stage / check / log line, every wait has its own timeout, and the caller
 * (main.js) also writes it from a watchdog and from crash handlers.
 */
const fs = require('node:fs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after ' + ms + ' ms: ' + label)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function createReport(outFile, meta) {
  const t0 = Date.now();
  const result = Object.assign({ ok: false, stage: 'starting', checks: [], log: [] }, meta || {});
  const MAX_LOG = 300;
  let writeFailed = false;

  function write() {
    if (!outFile) return;
    try { fs.writeFileSync(outFile, JSON.stringify(result, null, 2)); } catch (err) {
      if (!writeFailed) { writeFailed = true; console.log('SMOKE: could not write report to ' + outFile + ': ' + (err && err.message)); }
    }
  }
  function log(line) {
    if (result.log.length < MAX_LOG) result.log.push('+' + (Date.now() - t0) + 'ms ' + String(line).slice(0, 800));
    write();
  }
  function stage(name) { result.stage = name; log('stage: ' + name); }
  function check(name, pass, detail) {
    result.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });
    if (!pass) log('CHECK FAILED: ' + name + (detail !== undefined && detail !== null ? ' (' + detail + ')' : ''));
    else write();
  }
  function finish(ok) { result.ok = !!ok; result.finishedAfterMs = Date.now() - t0; write(); return result; }

  write();
  return { result, write, log, stage, check, finish };
}

async function run(ctx) {
  const { wc, report, Dates, openStore, closeStore, dbFile, userData } = ctx;
  const T = Object.assign({ step: 15000, load: 20000, ready: 25000, probe: 3000 }, ctx.timeouts || {});
  const evalJs = (code, label, ms) => withTimeout(wc.executeJavaScript(code, true), ms || T.step, label);

  // Resolves when the next page load ends (register BEFORE triggering the navigation).
  function nextLoad(label) {
    return withTimeout(new Promise((resolve, reject) => {
      const done = () => { wc.removeListener('did-fail-load', failed); resolve(); };
      const failed = (_e, code, desc, url) => { wc.removeListener('did-finish-load', done); reject(new Error('page failed to load (' + code + ' ' + desc + ') ' + url)); };
      wc.once('did-finish-load', done);
      wc.once('did-fail-load', failed);
    }), T.load, label);
  }

  // Wait until the renderer has defined window.__appReady, then until it settles.
  async function waitForApp(label) {
    report.stage(label + ': waiting for the page scripts');
    const deadline = Date.now() + T.load;
    let probe = null;
    while (Date.now() < deadline) {
      try {
        probe = await evalJs(`({ href: location.href, readyState: document.readyState, api: typeof window.api, appReady: typeof window.__appReady })`, 'probe page', T.probe);
        if (probe.appReady === 'object') break;
      } catch (err) { probe = { error: String(err && err.message) }; }
      await sleep(250);
    }
    report.log(label + ' probe: ' + JSON.stringify(probe));
    if (probe && probe.api !== 'object') report.log('WARNING: window.api is ' + probe.api + ' - the preload script did not expose the API');
    if (!probe || probe.appReady !== 'object') throw new Error('the page never defined window.__appReady (app.js did not run). Last probe: ' + JSON.stringify(probe));
    report.stage(label + ': waiting for the app to finish starting');
    const ok = await evalJs('window.__appReady', 'window.__appReady', T.ready);
    if (ok !== true) {
      let msg = '';
      try { msg = await evalJs(`(document.getElementById('calendar') || document.body).innerText`, 'read startup error', T.probe); } catch (_) { /* ignore */ }
      throw new Error('the app reported that it could not start: ' + String(msg).replace(/\s+/g, ' ').slice(0, 400));
    }
    await sleep(300);
  }

  let ok = false;
  try {
    report.stage('waiting for the window to load');
    // The window may already have finished loading by the time we get here.
    if (wc.isLoading()) await nextLoad('initial page load');
    await waitForApp('start-up');

    report.stage('checking the calendar UI');
    const now = Dates.todayParts();
    const expectedDays = Dates.daysInMonth(now.year, now.month);
    const ui = await evalJs(`(() => {
      const cells = [...document.querySelectorAll('.day[data-date]')];
      const prefix = ${JSON.stringify(Dates.monthKey(now.year, now.month) + '-')};
      return { days: cells.length, allInMonth: cells.every((c) => c.dataset.date.startsWith(prefix)),
               title: document.getElementById('title-text') && document.getElementById('title-text').textContent,
               hasApi: typeof window.api === 'object' };
    })()`, 'inspect calendar');
    report.check('window opens with preload API', ui.hasApi);
    report.check('calendar shows current month title', ui.title === Dates.MONTH_NAMES[now.month - 1] + ' ' + now.year, ui.title);
    report.check('calendar shows exactly the days of this month', ui.days === expectedDays, ui.days + ' of ' + expectedDays);
    report.check('no dates from adjacent months', ui.allInMonth);

    report.stage('saving a journal entry');
    const today = Dates.todayISO();
    const save = await evalJs(`window.api.rpc('saveEntry', [{ date: ${JSON.stringify(today)}, points: [{ text: 'smoke test ✓ বাংলা' }], review: 'persisted', status: 'in_progress', durationMin: 5 }])`, 'saveEntry');
    report.check('saving a journal entry works', save && save.ok, save && save.message);

    report.stage('checking that the network is blocked');
    const net = await evalJs(`fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'REACHED', () => 'BLOCKED')`, 'fetch');
    report.check('network requests are blocked (offline-only)', net === 'BLOCKED', net);

    report.stage('reloading the window');
    const reloaded = nextLoad('reload');
    wc.reload();
    await reloaded;
    await waitForApp('after reload');
    const after = await evalJs(`(() => { const t = document.querySelector('.day.today'); return { hasNotes: !!(t && t.classList.contains('has-notes')), text: document.querySelector('#editor') ? document.querySelector('#editor').innerText : '', points: [...document.querySelectorAll('.point-text')].map((p) => p.value).join('|') }; })()`, 'inspect after reload');
    report.check('entry still shown after reload', after.hasNotes);
    report.check('journal editor restores saved text', /smoke test ✓ বাংলা/.test(after.text) || /smoke test ✓ বাংলা/.test(after.points));

    report.stage('reading the database file back');
    // Prove it hit the disk: close the store and read the file back with a fresh connection.
    closeStore();
    const reopened = openStore();
    const back = reopened.getEntry(today);
    reopened.close();
    report.check('data is on disk in the per-user folder', back.points.length === 1 && back.review === 'persisted' && dbFile.startsWith(userData), dbFile);

    ok = report.result.checks.every((c) => c.pass);
    report.stage(ok ? 'finished: all checks passed' : 'finished: some checks failed');
  } catch (err) {
    report.check('smoke test ran to completion (failed at stage "' + report.result.stage + '")', false, String(err && err.stack || err));
    try {
      report.result.snapshot = await evalJs(`({ href: location.href, readyState: document.readyState, api: typeof window.api, appReady: typeof window.__appReady, title: document.title, text: (document.body && document.body.innerText || '').slice(0, 600) })`, 'failure snapshot', T.probe);
    } catch (e2) { report.result.snapshot = { unavailable: String(e2 && e2.message) }; }
    report.write();
  }
  return ok;
}

module.exports = { createReport, run, withTimeout };
