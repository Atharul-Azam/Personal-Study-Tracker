'use strict';
/*
 * End-to-end UI tests: the real renderer, real SQLite, driven in headless Chromium (Electron's engine).
 * Run with:  npm run test:ui     (needs Playwright + a Chromium: `npx playwright install chromium`)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startHarness, fixedClockScript } = require('./harness.js');
const D = require('../../src/shared/dates.js');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('playwright-core')); }

let browser;
const live = new Set();   // anything still open when the run ends is closed (so failures never hang the process)
test.before(async () => { browser = await chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => {
  for (const app of [...live]) { try { await app.finish(); } catch (e) { /* ignore */ } }
  if (browser) await browser.close();
});

// ----------------------------------------------------------------------------- helpers
async function launch(opts) {
  const o = opts || {};
  const h = o.harness || await startHarness();
  const ctx = await browser.newContext({ viewport: o.viewport || { width: 1366, height: 768 }, colorScheme: o.colorScheme || 'light' });
  const page = await ctx.newPage();
  const problems = [];
  const external = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('request', (r) => { if (!r.url().startsWith(h.origin) && !r.url().startsWith('data:')) external.push(r.url()); });
  await page.addInitScript(h.shim);
  if (o.today !== false) { const t = o.today || [2026, 11, 5]; await page.addInitScript(fixedClockScript(t[0], t[1], t[2], 10)); }
  await page.goto(h.url);
  assert.equal(await page.evaluate(() => window.__appReady), true, 'app booted');
  const app = { h, ctx, page, problems, external };
  live.add(app);
  app.finish = async () => { live.delete(app); await ctx.close().catch(() => {}); await h.close().catch(() => {}); };
  return app;
}

async function reload(app) { await app.page.reload(); assert.equal(await app.page.evaluate(() => window.__appReady), true); }
async function restart(app) { app.h.restartBackend(); await reload(app); }

const title = (page) => page.textContent('#title-text');
async function waitTitle(page, text) { await page.waitForFunction((t) => document.getElementById('title-text').textContent === t, text, { timeout: 5000 }); }
async function waitSaved(page) { await page.waitForFunction(() => { const s = document.getElementById('save-status'); return s && s.dataset.state === 'saved'; }, null, { timeout: 5000 }); }
async function saveState(page) { return page.evaluate(() => { const s = document.getElementById('save-status'); return s ? { state: s.dataset.state, text: s.textContent } : null; }); }
async function openDay(page, iso) {
  await page.click('[data-date="' + iso + '"]');
  const p = D.parseISO(iso);
  await page.waitForFunction((t) => document.getElementById('ed-title') && document.getElementById('ed-title').textContent.startsWith(t), D.formatLongDate(iso));
  return p;
}
const pointTexts = (page) => page.$$eval('.point-text', (els) => els.map((e) => e.value));
const dbPoints = (h, iso) => h.store.getEntry(iso).points.map((p) => p.text);
async function openSidebar(page) { if (await page.locator('#sidebar').isHidden()) await page.click('#btn-sidebar'); await page.waitForSelector('#sidebar:not([hidden])'); }
async function chips(page) {
  return page.$$eval('.summary .chip', (els) => Object.fromEntries(els.map((c) => [c.textContent.replace(c.querySelector('b').textContent, '').trim(), c.querySelector('b').textContent])));
}
async function modalClick(page, value) { await page.click('.modal [data-value="' + value + '"]'); await page.waitForSelector('.modal', { state: 'detached' }); }
function expectClean(app, label) {
  assert.deepEqual(app.problems, [], (label || 'page') + ': no console errors/warnings (includes CSP violations)');
  assert.deepEqual(app.external, [], (label || 'page') + ': made no requests outside the app');
}

async function gridSnapshot(page) {
  return page.evaluate(() => {
    const heads = [...document.querySelectorAll('.grid-head > div')].map((d) => d.textContent);
    const rows = [...document.querySelectorAll('.grid-row')].map((r) => [...r.children].map((c, col) => c.classList.contains('day')
      ? { col, date: c.dataset.date, label: c.querySelector('.day-num').textContent }
      : { col, blank: true, text: c.textContent.trim(), kids: c.children.length }));
    return { heads, rows };
  });
}

// ----------------------------------------------------------------------------- 1. startup & navigation
test('opens on the current month with today highlighted and only that month\'s dates', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page } = app;
  assert.equal(await title(page), 'November 2026');
  assert.equal(await page.locator('.day[data-date]').count(), 30);
  const dates = await page.$$eval('.day[data-date]', (els) => els.map((e) => e.dataset.date));
  assert.deepEqual(dates, Array.from({ length: 30 }, (_, i) => '2026-11-' + String(i + 1).padStart(2, '0')));
  assert.equal(await page.locator('.day.today').getAttribute('data-date'), '2026-11-05');
  assert.equal(await page.locator('.day.today').getAttribute('aria-current'), 'date');
  assert.equal(await page.locator('.day.has-notes').count(), 0, 'fresh install: no day is marked as having notes');
  assert.equal(await page.locator('#ed-title').textContent().then((t) => t.startsWith('Thursday, 5 November 2026')), true, 'today\'s journal is ready');
  assert.deepEqual(await app.h.store.counts(), { entries: 0, points: 0 }, 'opening today created nothing');
  expectClean(app);
  await app.finish();
});

test('opens on the real current month when the clock is not faked', async () => {
  const app = await launch({ today: false });
  const now = new Date();
  assert.equal(await title(app.page), D.MONTH_NAMES[now.getMonth()] + ' ' + now.getFullYear());
  assert.equal(await app.page.locator('.day[data-date]').count(), D.daysInMonth(now.getFullYear(), now.getMonth() + 1));
  expectClean(app);
  await app.finish();
});

test('previous / next / Today navigate correctly across year boundaries; rapid clicks never skip a step', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page } = app;
  await page.click('#btn-next'); await waitTitle(page, 'December 2026');
  assert.equal(await page.locator('.day[data-date]').count(), 31);
  await page.click('#btn-next'); await waitTitle(page, 'January 2027');
  await page.click('#btn-prev'); await waitTitle(page, 'December 2026');
  await page.click('#btn-prev'); await page.click('#btn-prev'); await waitTitle(page, 'October 2026');
  await page.click('#btn-today'); await waitTitle(page, 'November 2026');

  // 7 clicks fired back-to-back inside the page, no waiting in between
  await page.evaluate(() => { for (let i = 0; i < 7; i++) document.getElementById('btn-next').click(); });
  await waitTitle(page, 'June 2027');
  await page.waitForTimeout(150);
  assert.equal(await title(page), 'June 2027');
  assert.equal(await page.locator('.day[data-date]').count(), 30);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) document.getElementById('btn-prev').click(); });
  await waitTitle(page, 'October 2025');
  await page.click('#btn-today'); await waitTitle(page, 'November 2026');
  expectClean(app);
  await app.finish();
});

test('no ghost dates: every month 2023-12…2028-03, all week starts — counts, order, columns, blanks are empty', async () => {
  const app = await launch({ today: [2023, 12, 15], viewport: { width: 1366, height: 900 } });
  const { page } = app;
  await openSidebar(page);
  for (const ws of ['sun', 'mon', 'sat']) {
    await page.selectOption('#set-week-start', ws);
    await page.click('#btn-today');
    let y = 2023, m = 12;
    await waitTitle(page, D.MONTH_NAMES[m - 1] + ' ' + y);
    const first = D.WEEK_START[ws];
    for (let i = 0; i < 52; i++) {
      const snap = await gridSnapshot(page);
      const days = snap.rows.flat().filter((c) => !c.blank);
      const n = D.daysInMonth(y, m);
      assert.equal(days.length, n, y + '-' + m + ' (' + ws + ') day count');
      assert.deepEqual(days.map((c) => c.date), Array.from({ length: n }, (_, k) => D.toISO(y, m, k + 1)), y + '-' + m + ' dates in order, once each');
      days.forEach((c) => assert.equal(c.col, (D.weekdayOfISO(c.date) - first + 7) % 7, c.date + ' sits in the right weekday column (' + ws + ')'));
      snap.rows.flat().filter((c) => c.blank).forEach((c) => assert.ok(c.text === '' && c.kids === 0, 'blank cell must contain nothing'));
      assert.deepEqual(snap.heads, D.weekdayHeadings(ws).map((w) => w.short));
      assert.ok(snap.rows.every((r) => r.length === 7));
      await page.click('#btn-next');
      ({ year: y, month: m } = D.addMonths(y, m, 1));
      await waitTitle(page, D.MONTH_NAMES[m - 1] + ' ' + y);
    }
  }
  // leap years specifically
  for (const [yy, expected] of [[2024, 29], [2025, 28], [2028, 29]]) {
    await page.click('#btn-title'); await page.fill('#picker-year', String(yy)); await page.click('.picker-months [data-month="2"]');
    await waitTitle(page, 'February ' + yy);
    assert.equal(await page.locator('.day[data-date]').count(), expected, 'February ' + yy);
  }
  expectClean(app);
  await app.finish();
});

test('the first day of the week setting is respected (Monday: Nov 1 2026 is a Sunday → 6 leading blanks)', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page } = app;
  await openSidebar(page);
  await page.selectOption('#set-week-start', 'mon');
  const snap = await gridSnapshot(page);
  assert.deepEqual(snap.heads, ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((s) => s[0] + s.slice(1).toLowerCase()));
  assert.equal(snap.rows[0].filter((c) => c.blank).length, 6);
  assert.equal(snap.rows[0][6].date, '2026-11-01');
  await page.selectOption('#set-week-start', 'sat');
  const snap2 = await gridSnapshot(page);
  assert.equal(snap2.rows[0].filter((c) => c.blank).length, 1);
  assert.equal(snap2.rows[0][1].date, '2026-11-01');
  await app.finish();
});

test('month/year picker: jump to any month/year, validates input, Esc closes', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page } = app;
  await page.click('#btn-title');
  await page.waitForSelector('#picker:not([hidden])');
  assert.equal(await page.getAttribute('#btn-title', 'aria-expanded'), 'true');
  await page.fill('#picker-year', '2030');
  await page.click('.picker-months [data-month="2"]');
  await waitTitle(page, 'February 2030');
  assert.equal(await page.locator('#picker').isHidden(), true);

  await page.click('#btn-title');
  await page.fill('#picker-year', '1800');
  assert.match(await page.textContent('#picker-error'), /between 1900 and 2200/);
  await page.click('.picker-months [data-month="3"]');
  assert.equal(await title(page), 'February 2030', 'invalid year did not navigate');
  await page.fill('#picker-year', '2031');
  await page.press('#picker-year', 'Enter');
  await waitTitle(page, 'February 2031');
  await page.click('#btn-title'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#picker').isHidden(), true);
  await page.click('#btn-title'); await page.click('.topbar .brand');
  assert.equal(await page.locator('#picker').isHidden(), true, 'outside click closes');
  expectClean(app);
  await app.finish();
});

test('keyboard: PageUp/PageDown/T navigate when not typing, and are ignored inside text fields', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page } = app;
  await page.locator('.day[data-date="2026-11-10"]').focus();
  await page.keyboard.press('PageDown'); await waitTitle(page, 'December 2026');
  await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp'); await waitTitle(page, 'October 2026');
  await page.keyboard.press('t'); await waitTitle(page, 'November 2026');
  await page.fill('#review', 'typing t and PageDown here');
  await page.press('#review', 'PageDown');
  await page.keyboard.type('t');
  assert.equal(await title(page), 'November 2026');
  await app.finish();
});

// ----------------------------------------------------------------------------- 2. journals
test('each date has an independent journal; reopening restores it; opening alone creates nothing', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await openDay(page, '2026-11-10');
  await page.click('#add-point'); await page.keyboard.type('Day ten: pointers');
  await page.fill('#review', 'Review for the 10th');
  await waitSaved(page);

  await openDay(page, '2026-11-11');
  assert.deepEqual(await pointTexts(page), [], 'a different date starts empty');
  assert.equal(await page.inputValue('#review'), '');
  await page.click('#add-point'); await page.keyboard.type('Day eleven: recursion');
  await page.fill('#review', 'Review for the 11th');
  await waitSaved(page);

  await openDay(page, '2026-11-12');   // just look at it
  await openDay(page, '2026-11-10');
  assert.deepEqual(await pointTexts(page), ['Day ten: pointers']);
  assert.equal(await page.inputValue('#review'), 'Review for the 10th');
  await openDay(page, '2026-11-11');
  assert.deepEqual(await pointTexts(page), ['Day eleven: recursion']);
  assert.equal(await page.inputValue('#review'), 'Review for the 11th');

  assert.deepEqual(dbPoints(h, '2026-11-10'), ['Day ten: pointers']);
  assert.deepEqual(dbPoints(h, '2026-11-11'), ['Day eleven: recursion']);
  assert.equal(h.store.getEntry('2026-11-12').points.length, 0);
  assert.equal(h.store.counts().entries, 2, 'only the two days that were written exist');
  assert.equal(await page.locator('.day.has-notes').count(), 2);
  assert.equal(await page.locator('.day[data-date="2026-11-12"]').getAttribute('class').then((c) => c.includes('has-notes')), false);
  expectClean(app);
  await app.finish();
});

test('learning log: add (button + Ctrl+Enter), edit, reorder (buttons, Alt+arrows, drag & drop), delete + undo', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  const date = '2026-11-10';
  await openDay(page, date);

  await page.click('#add-point'); await page.keyboard.type('A');
  await page.keyboard.press('Control+Enter'); await page.keyboard.type('B');
  await page.keyboard.press('Control+Enter'); await page.keyboard.type('C');
  assert.deepEqual(await pointTexts(page), ['A', 'B', 'C']);
  assert.deepEqual(await page.$$eval('.point-mark', (e) => e.map((x) => x.textContent)), ['1.', '2.', '3.']);
  await waitSaved(page);
  assert.deepEqual(dbPoints(h, date), ['A', 'B', 'C']);

  await page.locator('.point-text').nth(1).fill('B edited\nsecond line');           // edit + multiline
  await waitSaved(page);
  assert.deepEqual(dbPoints(h, date), ['A', 'B edited\nsecond line', 'C']);

  await page.locator('.point').nth(2).locator('.mv-up').click();                      // button: C up → A, C, B
  assert.deepEqual(await pointTexts(page), ['A', 'C', 'B edited\nsecond line']);
  await page.locator('.point-text').nth(0).focus();
  await page.keyboard.press('Alt+ArrowDown');                                         // keyboard: A down → C, A, B
  assert.deepEqual(await pointTexts(page), ['C', 'A', 'B edited\nsecond line']);
  await page.keyboard.press('Alt+ArrowUp');                                           // and back up → A, C, B
  assert.deepEqual(await pointTexts(page), ['A', 'C', 'B edited\nsecond line']);
  await waitSaved(page);
  assert.deepEqual(dbPoints(h, date), ['A', 'C', 'B edited\nsecond line']);

  // drag & drop: drag the third item's handle onto the top half of the first item
  await page.locator('.point').nth(2).locator('.drag').dragTo(page.locator('.point').nth(0), { targetPosition: { x: 120, y: 4 } });
  await page.waitForFunction(() => document.querySelectorAll('.point-text')[0].value.startsWith('B edited'));
  assert.deepEqual(await pointTexts(page), ['B edited\nsecond line', 'A', 'C']);
  await waitSaved(page);
  assert.deepEqual(dbPoints(h, date), ['B edited\nsecond line', 'A', 'C']);

  // delete with undo
  await page.locator('.point').nth(1).locator('.del').click();
  assert.deepEqual(await pointTexts(page), ['B edited\nsecond line', 'C']);
  await page.click('.toast button:has-text("Undo")');
  assert.deepEqual(await pointTexts(page), ['B edited\nsecond line', 'A', 'C'], 'undo restores the point at its position');
  await page.locator('.point').nth(1).locator('.del').click();
  await waitSaved(page);
  assert.deepEqual(dbPoints(h, date), ['B edited\nsecond line', 'C']);

  // blank rows never reach the database; deleting everything removes the empty day
  await page.click('#add-point');
  await waitSaved(page);
  assert.deepEqual(dbPoints(h, date), ['B edited\nsecond line', 'C']);
  await page.locator('.point').nth(2).locator('.del').click();
  await page.locator('.point').nth(1).locator('.del').click();
  await page.locator('.point').nth(0).locator('.del').click();
  await waitSaved(page);
  assert.equal(h.store.counts().entries, 0);
  expectClean(app);
  await app.finish();
});

test('list style setting: numbers, bullets, checklist (done state is saved)', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await openDay(page, '2026-11-10');
  await page.click('#add-point'); await page.keyboard.type('one');
  await page.keyboard.press('Control+Enter'); await page.keyboard.type('two');
  await openSidebar(page);
  await page.selectOption('#set-list-style', 'bullets');
  assert.deepEqual(await page.$$eval('.point-mark', (e) => e.map((x) => x.textContent)), ['•', '•']);
  await page.selectOption('#set-list-style', 'checklist');
  assert.equal(await page.locator('.point-mark input[type=checkbox]').count(), 2);
  await page.locator('.point-mark input').nth(1).check();
  await waitSaved(page);
  assert.deepEqual(h.store.getEntry('2026-11-10').points.map((p) => p.done), [false, true]);
  assert.ok(await page.locator('.point').nth(1).getAttribute('class').then((c) => c.includes('done')));
  await restart(app);
  await openDay(app.page, '2026-11-10');
  assert.equal(await app.page.locator('.point-mark input').nth(1).isChecked(), true);
  expectClean(app);
  await app.finish();
});

test('personal review keeps line breaks, blank lines, indentation and Bangla text across a restart', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  const review = 'আজ যা বুঝলাম:\n  - pointers\n  - references\n\nকঠিন ছিল: templates\n\nRevise: STL';
  await openDay(page, '2026-11-10');
  await page.fill('#review', review);
  await page.click('#add-point'); await page.keyboard.type('বাংলা টেক্সট ✓ — C++ নোট');
  await waitSaved(page);
  assert.equal(h.store.getEntry('2026-11-10').review, review);
  await restart(app);
  await openDay(app.page, '2026-11-10');
  assert.equal(await app.page.inputValue('#review'), review);
  assert.deepEqual(await pointTexts(app.page), ['বাংলা টেক্সট ✓ — C++ নোট']);
  expectClean(app);
  await app.finish();
});

test('optional details: duration, status, tags, rating are saved, summarised and restored', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await openDay(page, '2026-11-10');
  assert.equal(await page.locator('details.meta').getAttribute('open'), null, 'details are collapsed when empty (no clutter)');
  await page.click('details.meta > summary');
  await page.fill('#duration', '135');
  await page.fill('#tags', 'cpp, dsa , গণিত, CPP');
  await page.click('.star[data-value="4"]');
  await page.selectOption('#ed-status', 'completed');
  await waitSaved(page);
  const e = h.store.getEntry('2026-11-10');
  assert.deepEqual([e.durationMin, e.status, e.rating, e.tags], [135, 'completed', 4, ['cpp', 'dsa', 'গণিত']]);
  assert.equal(await page.textContent('.meta-sum'), '2h 15m · ★ 4/5 · cpp, dsa, গণিত');
  await page.click('.star[data-value="4"]');            // clicking the same star clears it
  await waitSaved(page);
  assert.equal(h.store.getEntry('2026-11-10').rating, null);
  await restart(app);
  await openDay(app.page, '2026-11-10');
  assert.equal(await app.page.locator('details.meta').getAttribute('open') !== null, true, 'details open when they hold data');
  assert.equal(await app.page.inputValue('#duration'), '135');
  assert.equal(await app.page.inputValue('#ed-status'), 'completed');
  await app.finish();
});

// ----------------------------------------------------------------------------- 3. saving
test('autosave: status goes Unsaved → Saving → Saved, rapid typing yields one correct final value', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await openDay(page, '2026-11-10');
  assert.deepEqual(await saveState(page), { state: 'saved', text: 'Saved' });
  await page.click('#review');
  await page.keyboard.type('hello world, this is typed quickly', { delay: 5 });
  assert.equal((await saveState(page)).state, 'unsaved');
  assert.equal((await saveState(page)).text, 'Unsaved changes');
  assert.equal(h.store.getEntry('2026-11-10').review, '', 'debounced: nothing written while still typing');
  await waitSaved(page);
  assert.equal(h.store.getEntry('2026-11-10').review, 'hello world, this is typed quickly');
  assert.equal(h.rpcLog.filter((m) => m === 'saveEntry').length, 1, 'one save for one burst of typing');
  expectClean(app);
  await app.finish();
});

test('no data loss: navigating to another date / month / closing the window right after typing saves first', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await openDay(page, '2026-11-10');
  await page.fill('#review', 'typed then immediately switched date');
  await page.click('[data-date="2026-11-11"]');                         // well inside the 700 ms debounce
  await page.waitForFunction(() => document.getElementById('ed-title').textContent.startsWith('Wednesday, 11'));
  assert.equal(h.store.getEntry('2026-11-10').review, 'typed then immediately switched date');

  await page.fill('#review', 'typed then immediately switched month');
  await page.click('#btn-next'); await waitTitle(page, 'December 2026');
  await page.waitForFunction(() => document.getElementById('save-status').dataset.state === 'saved');
  assert.equal(h.store.getEntry('2026-11-11').review, 'typed then immediately switched month');

  await page.fill('#review', 'typed then window close requested');
  await page.evaluate(() => window.__closeRequested());
  await page.waitForFunction(() => window.__closeResponse === true);
  assert.equal(h.store.getEntry('2026-11-11').review, 'typed then window close requested');

  await page.fill('#review', 'saved with Ctrl+S');
  await page.keyboard.press('Control+s');
  await waitSaved(page);
  assert.equal(h.store.getEntry('2026-11-11').review, 'saved with Ctrl+S');
  expectClean(app);
  await app.finish();
});

test('rapidly clicking many dates never mixes journals; typing lands on the last one only', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await page.evaluate(() => { for (let d = 1; d <= 20; d++) document.querySelector('[data-date="2026-11-' + String(d).padStart(2, '0') + '"]').click(); });
  await page.waitForFunction(() => document.getElementById('ed-title') && document.getElementById('ed-title').textContent.startsWith('Friday, 20 November'));
  await page.fill('#review', 'only the 20th');
  await waitSaved(page);
  assert.equal(h.store.counts().entries, 1);
  assert.equal(h.store.getEntry('2026-11-20').review, 'only the 20th');
  assert.equal(await page.locator('.day.selected').getAttribute('data-date'), '2026-11-20');
  expectClean(app);
  await app.finish();
});

test('autosave OFF: unsaved changes are never lost silently — Save / Discard / Cancel prompt; Ctrl+S saves; setting persists', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await openSidebar(page);
  await page.uncheck('#set-autosave');
  await openDay(page, '2026-11-10');
  await page.fill('#review', 'manual save only');
  await page.waitForTimeout(1200);
  assert.equal(h.store.getEntry('2026-11-10').review, '', 'autosave is off: nothing written');
  assert.match((await saveState(page)).text, /Unsaved changes \(Ctrl\+S to save\)/);

  await page.click('[data-date="2026-11-11"]');
  await page.waitForSelector('.modal');
  assert.match(await page.textContent('.modal h2'), /Unsaved changes/);
  await modalClick(page, 'cancel');
  assert.equal(await page.inputValue('#review'), 'manual save only', 'Cancel keeps the edit and stays on the date');

  await page.click('[data-date="2026-11-11"]'); await modalClick(page, 'discard');
  await page.waitForFunction(() => document.getElementById('ed-title').textContent.startsWith('Wednesday, 11'));
  assert.equal(h.store.counts().entries, 0, 'Discard really discards');

  await page.fill('#review', 'saved via the dialog');
  await page.click('[data-date="2026-11-12"]'); await modalClick(page, 'save');
  await page.waitForFunction(() => document.getElementById('ed-title').textContent.startsWith('Thursday, 12'));
  assert.equal(h.store.getEntry('2026-11-11').review, 'saved via the dialog');

  await page.fill('#review', 'saved with the shortcut');
  await page.keyboard.press('Control+s'); await waitSaved(page);
  assert.equal(h.store.getEntry('2026-11-12').review, 'saved with the shortcut');

  await page.fill('#review', 'month switch also asks');
  await page.click('#btn-next');
  await page.waitForSelector('.modal'); await modalClick(page, 'cancel');
  assert.equal(await title(page), 'November 2026');
  await page.evaluate(() => window.__closeRequested());
  await page.waitForSelector('.modal'); await modalClick(page, 'cancel');
  assert.equal(await page.evaluate(() => window.__closeResponse), false, 'closing the window is blocked while the user cancels');
  await page.keyboard.press('Control+s'); await waitSaved(page);

  await restart(app);
  await openSidebar(app.page);
  assert.equal(await app.page.isChecked('#set-autosave'), false, 'preference persisted');
  expectClean(app);
  await app.finish();
});

test('a failed save is reported, keeps the edit, blocks navigation until the user decides, and retries', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await openDay(page, '2026-11-10');
  h.failNextSave = true;
  await page.fill('#review', 'this save will fail once');
  await page.waitForFunction(() => document.getElementById('save-status').dataset.state === 'error');
  assert.equal((await saveState(page)).text, 'Not saved');
  assert.match(await page.textContent('.toast.error'), /Simulated disk failure/);
  assert.equal(h.store.counts().entries, 0);

  h.failNextSave = true;
  await page.click('[data-date="2026-11-11"]');
  await page.waitForSelector('.modal');
  assert.match(await page.textContent('.modal h2'), /could not be saved/);
  await modalClick(page, 'stay');
  assert.equal(await page.inputValue('#review'), 'this save will fail once', 'edit still there');
  assert.equal(await page.locator('#ed-title').textContent().then((t) => t.startsWith('Tuesday, 10')), true, 'stayed on the same date');

  await page.keyboard.press('Control+s');                 // next attempt succeeds
  await waitSaved(page);
  assert.equal(h.store.getEntry('2026-11-10').review, 'this save will fail once');
  expectClean({ problems: app.problems.filter((p) => !/Failed to load resource/.test(p)), external: app.external });
  await app.finish();
});

// ----------------------------------------------------------------------------- 4. views
test('Grid and List show identical data; switching views changes nothing; the view persists across restarts', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  h.store.saveEntry({ date: '2026-11-02', points: [{ text: 'GitHub' }, { text: 'Pointers' }, { text: 'Linked lists' }], review: 'r', durationMin: 95, status: 'completed' });
  h.store.saveEntry({ date: '2026-11-03', points: [{ text: 'বাংলা' }], status: 'in_progress' });
  h.store.saveEntry({ date: '2026-11-04', review: 'reflection only' });
  await reload(app);
  const before = JSON.stringify(h.store.getAllEntries());

  const gridInfo = await page.$$eval('.day[data-date]', (els) => els.map((e) => [e.dataset.date, e.getAttribute('aria-label'), e.classList.contains('has-notes'), e.dataset.status]));
  assert.equal(gridInfo.length, 30);
  await page.click('[data-view="list"]');
  await page.waitForSelector('.list .card');
  const listInfo = await page.$$eval('.card[data-date]', (els) => els.map((e) => [e.dataset.date, e.getAttribute('aria-label'), e.classList.contains('has-notes'), e.dataset.status]));
  assert.deepEqual(listInfo, gridInfo, 'same dates, same descriptions, same marks in both views');

  const c2 = page.locator('.card[data-date="2026-11-02"]');
  assert.match(await c2.textContent(), /GitHub/); assert.match(await c2.textContent(), /\+1 more/);
  assert.match(await c2.textContent(), /Completed/); assert.match(await c2.textContent(), /1h 35m/);
  assert.match(await page.locator('.card[data-date="2026-11-03"]').textContent(), /বাংলা.*In progress/s);
  assert.match(await page.locator('.card[data-date="2026-11-04"]').textContent(), /Personal review only/);
  assert.equal(await page.locator('.card.empty').count(), 27);
  assert.equal(await page.locator('.card .card-date .w').first().textContent(), 'SUN'.charAt(0) + 'un');
  assert.equal(await page.locator('.card[data-date]').count(), 30, 'list shows only this month');
  const scrollable = await page.$eval('.list', (l) => l.scrollHeight > l.clientHeight);
  assert.equal(scrollable, true, 'the list scrolls');
  await page.click('.card[data-date="2026-11-03"]');                                   // card opens its journal
  await page.waitForFunction(() => document.getElementById('ed-title').textContent.startsWith('Tuesday, 3'));
  assert.deepEqual(await pointTexts(page), ['বাংলা']);
  assert.equal(await page.locator('.card.selected').getAttribute('data-date'), '2026-11-03');

  await page.click('[data-view="grid"]');
  assert.equal(await page.locator('.day[data-date]').count(), 30);
  assert.equal(JSON.stringify(h.store.getAllEntries()), before, 'switching views never modifies data');

  await page.click('[data-view="list"]');
  await restart(app);
  assert.equal(await app.page.locator('.card[data-date]').count(), 30, 'List view remembered after restart');
  assert.equal(await app.page.getAttribute('[data-view="list"]', 'aria-pressed'), 'true');
  assert.equal(JSON.stringify(h.store.getAllEntries()), before);
  expectClean(app);
  await app.finish();
});

test('list view: no ghost dates in any month, including February of a leap year', async () => {
  const app = await launch({ today: [2024, 1, 20] });
  const { page } = app;
  await page.click('[data-view="list"]');
  for (const [y, m] of [[2024, 1], [2024, 2], [2024, 3], [2025, 2], [2025, 12], [2026, 1]]) {
    await page.click('#btn-title'); await page.fill('#picker-year', String(y)); await page.click('.picker-months [data-month="' + m + '"]');
    await waitTitle(page, D.MONTH_NAMES[m - 1] + ' ' + y);
    const dates = await page.$$eval('.card[data-date]', (e) => e.map((x) => x.dataset.date));
    assert.deepEqual(dates, D.buildMonthList(y, m).map((d) => d.iso), y + '-' + m);
  }
  await app.finish();
});

// ----------------------------------------------------------------------------- 5. appearance
test('theme: Light / Dark / System apply everywhere, follow the OS in System mode, and persist', async () => {
  const app = await launch({ today: [2026, 11, 5], colorScheme: 'light' });
  const { page } = app;
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });   // no colour transitions while we read styles
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await openSidebar(page);
  await page.click('[data-setting="theme"][data-value="light"]');
  assert.equal(await theme(), 'light'); const lightBg = await bg();
  await page.click('[data-setting="theme"][data-value="dark"]');
  assert.equal(await theme(), 'dark'); const darkBg = await bg();
  assert.notEqual(lightBg, darkBg);
  assert.equal(darkBg, 'rgb(22, 24, 26)');
  const surfaces = await page.evaluate(() => ['.topbar', '.sidebar', '.editor', '.day', '.summary .chip', '.btn', '#review'].map((s) => [s, getComputedStyle(document.querySelector(s)).backgroundColor]));
  surfaces.forEach(([sel, color]) => assert.ok(!['rgb(255, 254, 251)', 'rgb(246, 244, 239)'].includes(color), sel + ' uses the dark palette, got ' + color));
  assert.equal(await page.getAttribute('[data-setting="theme"][data-value="dark"]', 'aria-pressed'), 'true');

  await page.click('[data-setting="theme"][data-value="system"]');
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(100);
  assert.equal(await theme(), 'dark');
  await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(100);
  assert.equal(await theme(), 'light');

  await page.click('[data-setting="theme"][data-value="dark"]');
  await restart(app);
  assert.equal(await theme(), 'dark', 'persisted across restart');
  assert.equal(await bg(), 'rgb(22, 24, 26)');
  assert.equal(app.h.store.getSettings().theme, 'dark');
  expectClean(app);
  await app.finish();
});

test('fonts: family and size for interface and editor apply immediately, persist, reset works; Bangla has a fallback', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page } = app;
  await openSidebar(page);
  const rootSize = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  const editorSize = () => page.evaluate(() => getComputedStyle(document.getElementById('review')).fontSize);
  assert.equal(await rootSize(), '14px'); assert.equal(await editorSize(), '15px');
  for (let i = 0; i < 3; i++) await page.click('button[data-setting="uiFontSize"][data-step="1"]');
  for (let i = 0; i < 4; i++) await page.click('button[data-setting="editorFontSize"][data-step="1"]');
  assert.equal(await rootSize(), '17px'); assert.equal(await editorSize(), '19px');
  assert.equal(await page.textContent('#out-ui-size'), '17 px');
  for (let i = 0; i < 30; i++) await page.click('button[data-setting="editorFontSize"][data-step="1"]');
  assert.equal(await editorSize(), '28px', 'clamped at the maximum');

  const options = await page.$$eval('#set-editor-font option', (o) => o.map((x) => x.value));
  assert.equal(options[0], 'system');
  const installed = options.filter((v) => v !== 'system');
  assert.ok(installed.length > 0, 'at least one installed font offered on this machine: ' + options.join(', '));
  const pick = installed[0];
  await page.selectOption('#set-editor-font', pick);
  await page.selectOption('#set-ui-font', pick);
  const fam = await page.evaluate(() => [getComputedStyle(document.body).fontFamily, getComputedStyle(document.getElementById('review')).fontFamily]);
  fam.forEach((f) => { assert.ok(f.includes(pick), 'family applied: ' + f); assert.ok(/Nirmala UI|Noto Sans Bengali/.test(f), 'Bangla fallback present: ' + f); });
  assert.deepEqual(await page.evaluate(() => document.getElementById('font-preview').textContent.includes('বাংলা')), true);

  await restart(app);
  const st = app.h.store.getSettings();
  assert.deepEqual([st.uiFont, st.editorFont, st.uiFontSize, st.editorFontSize], [pick, pick, 17, 28]);
  assert.equal(await rootSize(), '17px'); assert.equal(await editorSize(), '28px');
  assert.equal(await page.inputValue('#set-ui-font'), pick);

  await page.click('#reset-fonts');
  assert.equal(await rootSize(), '14px'); assert.equal(await editorSize(), '15px');
  assert.equal(await page.inputValue('#set-ui-font'), 'system');
  expectClean(app);
  await app.finish();
});

// ----------------------------------------------------------------------------- 6. statistics
test('monthly statistics follow the documented rules and update live; opening a day never completes it', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  assert.deepEqual(await chips(page), { 'study days': '0', completed: '0', 'learning points': '0', 'time recorded': '—' });
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) await openDay(page, d);
  assert.deepEqual(await chips(page), { 'study days': '0', completed: '0', 'learning points': '0', 'time recorded': '—' }, 'merely opening days changes nothing');
  assert.equal(h.store.counts().entries, 0);

  h.store.saveEntry({ date: '2026-11-01', points: [{ text: 'a' }, { text: 'b' }], status: 'completed', durationMin: 60, review: 'r' });
  h.store.saveEntry({ date: '2026-11-02', points: [{ text: 'c' }], status: 'in_progress', durationMin: 30 });
  h.store.saveEntry({ date: '2026-11-04', review: 'reflection only' });
  h.store.saveEntry({ date: '2026-10-31', points: [{ text: 'other month' }], status: 'completed', durationMin: 500 });
  await reload(app);
  assert.deepEqual(await chips(page), { 'study days': '2', completed: '1', 'learning points': '3', studied: '1h 30m', 'with review': '2' });

  await openDay(page, '2026-11-03');
  await page.click('#add-point'); await page.keyboard.type('new point today');
  await page.selectOption('#ed-status', 'completed');
  await waitSaved(page);
  await page.waitForFunction(() => document.querySelector('.summary .chip b').textContent === '3');
  assert.deepEqual(await chips(page), { 'study days': '3', completed: '2', 'learning points': '4', studied: '1h 30m', 'with review': '2' });
  expectClean(app);
  await app.finish();
});

// ----------------------------------------------------------------------------- 7. backup / restore
function seedBackupSource(h) {
  h.store.saveEntry({ date: '2026-11-01', points: [{ text: 'বাংলা', done: true }, { text: 'two\nlines' }], review: 'r1\nr2', durationMin: 45, status: 'completed', tags: ['a', 'b'], rating: 5 });
  h.store.saveEntry({ date: '2026-11-02', points: [{ text: 'second day' }], status: 'in_progress' });
  h.store.setSettings({ theme: 'dark', view: 'list' });
}

test('export JSON from the UI, then restore it into a brand-new installation', async () => {
  const a = await launch({ today: [2026, 11, 5] });
  seedBackupSource(a.h);
  await reload(a);
  await openSidebar(a.page);
  await a.page.click('#btn-export-json');
  await a.page.waitForSelector('.toast');
  assert.match(await a.page.textContent('.toast'), /All records exported to/);
  const exported = a.h.lastExport.json;
  assert.ok(exported && exported.text.length > 50);
  assert.equal(JSON.parse(exported.text).entries.length, 2);
  await a.page.click('#btn-export-csv');
  await a.page.waitForFunction(() => document.querySelectorAll('.toast').length >= 2);
  assert.match(a.h.lastExport.csv.text, /2026-11-01,Sunday,Completed,45,2,1,5,a; b,yes,/);
  const original = { d1: a.h.store.getEntry('2026-11-01'), d2: a.h.store.getEntry('2026-11-02') };
  await a.finish();

  const b = await launch({ today: [2026, 11, 5] });
  b.h.nextImportText = exported.text;
  await openSidebar(b.page);
  await b.page.click('#btn-import-json');
  await b.page.waitForSelector('.modal');
  assert.match(await b.page.textContent('.modal'), /2 days/);
  assert.equal(await b.page.locator('.radio').count(), 2, 'nothing to overwrite → only "add" and "replace" are offered');
  await b.page.check('#restore-settings');
  await modalClick(b.page, 'go');
  await b.page.waitForSelector('.toast');
  assert.match(await b.page.textContent('.toast'), /2 added, 0 overwritten, 0 skipped/);
  assert.deepEqual(b.h.store.getEntry('2026-11-01'), original.d1);
  assert.deepEqual(b.h.store.getEntry('2026-11-02'), original.d2);
  assert.equal(await b.page.locator('.day.has-notes, .card.has-notes').count(), 2, 'calendar refreshed without a reload');
  assert.equal(await b.page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'settings restored on request');
  assert.equal(await b.page.locator('.card[data-date]').count(), 30, 'view setting restored');
  await openDay(b.page, '2026-11-01');
  assert.deepEqual(await pointTexts(b.page), ['বাংলা', 'two\nlines']);
  expectClean(b);
  await b.finish();
});

test('restore never silently overwrites: conflicts default to "keep mine"; overwrite/replace make a safety backup', async () => {
  const src = await startHarness();
  seedBackupSource(src);
  const backupText = (await src.service.invoke('exportJson', [])).data.text;
  await src.close();

  // --- default (skip): existing day untouched
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  h.store.saveEntry({ date: '2026-11-01', points: [{ text: 'MY OWN NOTES' }], review: 'mine' });
  h.store.saveEntry({ date: '2026-12-25', points: [{ text: 'unrelated day' }] });
  await reload(app);
  await openSidebar(page);
  h.nextImportText = backupText;
  await page.click('#btn-import-json'); await page.waitForSelector('.modal');
  assert.equal(await page.locator('.radio').count(), 3);
  assert.equal(await page.isChecked('.radio[data-mode="skip"] input'), true, '"keep mine" is the default');
  assert.match(await page.textContent('.modal'), /1 already here/);
  await modalClick(page, 'go');
  await page.waitForSelector('.toast');
  assert.match(await page.textContent('.toast'), /1 added, 0 overwritten, 1 skipped/);
  assert.deepEqual(dbPoints(h, '2026-11-01'), ['MY OWN NOTES']);
  assert.equal(h.store.getSettings().theme, 'system', 'settings are only restored when ticked');

  // --- cancel changes nothing
  h.nextImportText = backupText;
  await page.click('#btn-import-json'); await page.waitForSelector('.modal');
  await page.check('.radio[data-mode="overwrite"] input');
  await modalClick(page, 'cancel');
  assert.deepEqual(dbPoints(h, '2026-11-01'), ['MY OWN NOTES']);

  // --- overwrite: only the backup's dates change; safety backup of the previous state exists
  h.nextImportText = backupText;
  await page.click('#btn-import-json'); await page.waitForSelector('.modal');
  await page.check('.radio[data-mode="overwrite"] input');
  await modalClick(page, 'go');
  await page.waitForSelector('.toast:has-text("2 overwritten")');
  assert.deepEqual(dbPoints(h, '2026-11-01'), ['বাংলা', 'two\nlines']);
  assert.deepEqual(dbPoints(h, '2026-12-25'), ['unrelated day'], 'days not in the backup are untouched');
  const backups = fs.readdirSync(path.join(h.dir, 'backups')).filter((f) => f.includes('before-restore'));
  assert.equal(backups.length, 1, 'one automatic safety backup');
  const { createStore } = require('../../src/main/store.js');
  const snap = createStore(path.join(h.dir, 'backups', backups[0]));
  assert.deepEqual(snap.getEntry('2026-11-01').points.map((p) => p.text), ['MY OWN NOTES'], 'safety backup holds the pre-restore data');
  snap.close();

  // --- replace: asks twice
  h.nextImportText = backupText;
  await page.click('#btn-import-json'); await page.waitForSelector('.modal');
  await page.check('.radio[data-mode="replace"] input');
  await page.click('.modal [data-value="go"]');
  await page.waitForFunction(() => /Replace all current data/.test((document.querySelector('.modal h2') || {}).textContent || ''));
  await modalClick(page, 'no');
  assert.deepEqual(dbPoints(h, '2026-12-25'), ['unrelated day'], 'declining the confirmation changes nothing');
  h.nextImportText = backupText;
  await page.click('#btn-import-json'); await page.waitForSelector('.modal');
  await page.check('.radio[data-mode="replace"] input');
  await page.click('.modal [data-value="go"]');
  await page.waitForFunction(() => /Replace all current data/.test((document.querySelector('.modal h2') || {}).textContent || ''));
  await modalClick(page, 'yes');
  await page.waitForSelector('.toast:has-text("Restore finished")');
  assert.equal(h.store.counts().entries, 2);
  assert.equal(h.store.getEntry('2026-12-25').points.length, 0);
  expectClean(app);
  await app.finish();
});

test('invalid, corrupted and foreign backup files are rejected with clear messages and change nothing', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  h.store.saveEntry({ date: '2026-11-01', points: [{ text: 'precious' }] });
  await reload(app);
  await openSidebar(page);
  const good = { app: 'study-tracker', formatVersion: 1, entries: [{ date: '2026-11-09', points: [{ text: 'x' }] }] };
  const bad = {
    'not JSON at all': 'this is { not json',
    'truncated file': JSON.stringify(good).slice(0, 40),
    'wrong app': JSON.stringify({ ...good, app: 'other' }),
    'impossible date (Feb 30)': JSON.stringify({ ...good, entries: [{ date: '2026-02-30' }] }),
    'newer format version': JSON.stringify({ ...good, formatVersion: 50 }),
    'empty file': ''
  };
  for (const [name, text] of Object.entries(bad)) {
    h.nextImportText = text;
    await page.click('#btn-import-json');
    await page.waitForSelector('.modal');
    const body = await page.textContent('.modal');
    assert.match(await page.textContent('.modal h2'), /can't be restored/, name);
    assert.ok(!/Error:|at .*\.js:\d+|SyntaxError|undefined/.test(body), name + ': no technical jargon in "' + body + '"');
    await modalClick(page, 'true');
    assert.deepEqual(dbPoints(h, '2026-11-01'), ['precious'], name + ': data intact');
    assert.equal(h.store.counts().entries, 1, name);
  }
  expectClean(app);
  await app.finish();
});

test('"Create full local backup" writes a restorable database copy into the backups folder', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await openDay(page, '2026-11-10');
  await page.fill('#review', 'typed right before the backup');     // not yet autosaved: backup must still include it
  await openSidebar(page);
  await page.click('#btn-create-backup');
  await page.waitForSelector('.toast:has-text("Backup created")');
  const files = fs.readdirSync(path.join(h.dir, 'backups'));
  assert.equal(files.length, 1);
  const { createStore } = require('../../src/main/store.js');
  const copy = createStore(path.join(h.dir, 'backups', files[0]));
  assert.equal(copy.getEntry('2026-11-10').review, 'typed right before the backup');
  copy.close();
  assert.equal(await page.textContent('#backup-path'), path.join(h.dir, 'backups'));
  assert.equal(await page.textContent('#data-path'), h.dbFile, 'storage location is shown in Settings');
  await page.waitForFunction(() => /1 day with notes/.test(document.getElementById('data-counts').textContent));
  await app.finish();
});

// ----------------------------------------------------------------------------- 8. offline & robustness
test('works with no network at all (every non-local host fails to resolve) and never contacts anything outside the app', async () => {
  const h = await startHarness();
  const offlineBrowser = await chromium.launch({ args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const ctx = await offlineBrowser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const attempted = [], problems = [];
  page.on('request', (r) => { if (!r.url().startsWith(h.origin)) attempted.push(r.url()); });
  page.on('pageerror', (e) => problems.push(e.message));
  await page.addInitScript(h.shim);
  await page.addInitScript(fixedClockScript(2026, 11, 5, 10));
  await page.goto(h.url);
  assert.equal(await page.evaluate(() => window.__appReady), true);
  await openDay(page, '2026-11-10');
  await page.click('#add-point'); await page.keyboard.type('studied offline');
  await waitSaved(page);
  assert.deepEqual(dbPoints(h, '2026-11-10'), ['studied offline']);
  const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  assert.match(csp, /default-src 'none'/);
  assert.ok(!/https?:\/\/[^'" ]*\./.test(csp), 'CSP names no external hosts');
  const probes = await page.evaluate(async () => {
    const r = [];
    for (const u of ['https://example.com/', 'http://example.com/']) {
      try { await fetch(u, { mode: 'no-cors' }); r.push('REACHED'); } catch (e) { r.push('blocked'); }
    }
    return r;
  });
  assert.deepEqual(probes, ['blocked', 'blocked'], 'external fetches fail (CSP + no network)');
  // nothing in the shipped UI source references a remote resource
  const srcDir = path.join(__dirname, '..', '..', 'src', 'renderer');
  for (const f of ['index.html', 'css/app.css', ...fs.readdirSync(path.join(srcDir, 'js')).map((x) => 'js/' + x)]) {
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(text) && !/url\(\s*["']?https?:/i.test(text) && !/@import\s+url\(["']?http/i.test(text), f + ' references no remote resource');
  }
  assert.deepEqual(attempted, [], 'the page itself never requested anything outside the app');
  assert.deepEqual(problems, []);
  await ctx.close(); await offlineBrowser.close(); await h.close();
});

test('layouts: no horizontal overflow at the minimum window size, laptop and large desktop; editor becomes an overlay when narrow', async () => {
  for (const [w, hgt] of [[760, 560], [1024, 640], [1366, 768], [1920, 1080]]) {
    const app = await launch({ today: [2026, 11, 5], viewport: { width: w, height: hgt } });
    const { page } = app;
    for (const view of ['grid', 'list']) {
      await page.click('[data-view="' + view + '"]');
      const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bw: document.body.scrollWidth }));
      assert.ok(over.sw <= over.iw && over.bw <= over.iw, w + 'x' + hgt + ' ' + view + ' overflows horizontally: ' + JSON.stringify(over));
    }
    await openSidebar(page);
    const ov2 = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(ov2, w + 'x' + hgt + ' with sidebar');
    if (w <= 960) {
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('editor')).position), 'absolute', 'editor overlays on narrow windows');
      await page.click('#ed-close');
      await page.waitForSelector('#editor', { state: 'hidden' });   // closing is asynchronous (it flushes first)
      await page.click('.day[data-date="2026-11-10"], .card[data-date="2026-11-10"]');
      await page.waitForSelector('#editor', { state: 'visible' });
    }
    if (w === 1366) await page.screenshot({ path: path.join(process.env.ST_SHOTS || require('node:os').tmpdir(), 'ui-1366.png') });
    assert.deepEqual(app.problems, [], w + 'x' + hgt);
    await app.finish();
  }
});

test('window resizing while editing does not lose text or break the layout', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  await openDay(page, '2026-11-10');
  await page.click('#add-point'); await page.keyboard.type('a fairly long learning point that will need to wrap when the window gets narrower '.repeat(3));
  for (const [w, hgt] of [[900, 600], [760, 560], [1500, 900], [1366, 768]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.waitForTimeout(150);
    const ok = await page.evaluate(() => { const t = document.querySelector('.point-text'); return t.scrollHeight <= t.clientHeight + 2; });
    assert.ok(ok, 'textarea grows to fit its text at ' + w);
  }
  await waitSaved(page);
  assert.equal(h.store.getEntry('2026-11-10').points.length, 1);
  assert.deepEqual(app.problems, []);
  await app.finish();
});

test('data survives many restarts and ordinary navigation (end-to-end soak)', async () => {
  const app = await launch({ today: [2026, 11, 5] });
  const { page, h } = app;
  const written = {};
  for (let i = 1; i <= 6; i++) {
    const iso = D.toISO(2026, 11, i * 3);
    await openDay(page, iso);
    await page.click('#add-point'); await page.keyboard.type('note ' + i + ' বাংলা');
    await page.fill('#review', 'review ' + i + '\nline two');
    written[iso] = { points: ['note ' + i + ' বাংলা'], review: 'review ' + i + '\nline two' };
    await page.click('#btn-next'); await page.click('#btn-prev');         // wander around between edits
    await waitTitle(page, 'November 2026');
    if (i % 2 === 0) await restart(app);
  }
  await restart(app);
  for (const [iso, exp] of Object.entries(written)) {
    assert.deepEqual(dbPoints(h, iso), exp.points, iso);
    assert.equal(h.store.getEntry(iso).review, exp.review, iso);
    await openDay(app.page, iso);
    assert.deepEqual(await pointTexts(app.page), exp.points);
    assert.equal(await app.page.inputValue('#review'), exp.review);
  }
  assert.equal(h.store.counts().entries, 6);
  expectClean(app);
  await app.finish();
});

// ----------------------------------------------------------------------------- 9. start-up failures never hang
test('start-up never hangs: with no preload bridge, or a bridge that fails, __appReady settles to false and a clear message is shown', async () => {
  const h = await startHarness();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    // (a) the preload bridge is missing altogether (window.api undefined)
    const a = await ctx.newPage();
    await a.goto(h.url);
    const readyA = await Promise.race([a.evaluate(() => window.__appReady), new Promise((r) => setTimeout(() => r('HUNG'), 5000))]);
    assert.equal(readyA, false, 'no bridge → __appReady resolves false (does not hang)');
    const textA = await a.textContent('#calendar');
    assert.match(textA, /could not start/i);
    assert.match(textA, /preload/i);

    // (b) the bridge exists but every call fails
    const b = await ctx.newPage();
    await b.addInitScript(`window.api = { rpc: () => Promise.reject(new Error('boom')), onCloseRequested() {}, respondToClose() {} };`);
    await b.goto(h.url);
    const readyB = await Promise.race([b.evaluate(() => window.__appReady), new Promise((r) => setTimeout(() => r('HUNG'), 5000))]);
    assert.equal(readyB, false);
    assert.match(await b.textContent('#calendar'), /could not start/i);

    // (c) the bridge throws synchronously
    const c = await ctx.newPage();
    await c.addInitScript(`window.api = { rpc: () => { throw new Error('sync boom'); } };`);
    await c.goto(h.url);
    const readyC = await Promise.race([c.evaluate(() => window.__appReady), new Promise((r) => setTimeout(() => r('HUNG'), 5000))]);
    assert.equal(readyC, false);
  } finally {
    await ctx.close().catch(() => {}); await h.close().catch(() => {});
  }
});
