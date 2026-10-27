'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../src/shared/dates.js');

const MONTH_LENGTHS_COMMON = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

test('daysInMonth is right for every month, common and leap years', () => {
  MONTH_LENGTHS_COMMON.forEach((len, i) => assert.equal(D.daysInMonth(2025, i + 1), len, 'month ' + (i + 1)));
  assert.equal(D.daysInMonth(2024, 2), 29);
  assert.equal(D.daysInMonth(2028, 2), 29);
  assert.equal(D.daysInMonth(2100, 2), 28, '2100 is not a leap year');
  assert.equal(D.daysInMonth(2000, 2), 29, '2000 is a leap year');
  assert.equal(D.daysInMonth(1900, 2), 28);
});

test('daysInMonth rejects invalid input', () => {
  assert.throws(() => D.daysInMonth(2025, 0), RangeError);
  assert.throws(() => D.daysInMonth(2025, 13), RangeError);
  assert.throws(() => D.daysInMonth(2025.5, 3), RangeError);
});

test('isLeapYear', () => {
  assert.deepEqual([1900, 2000, 2023, 2024, 2100, 2400].map(D.isLeapYear), [false, true, false, true, false, true]);
});

test('parseISO accepts real dates and rejects impossible ones', () => {
  assert.deepEqual(D.parseISO('2024-02-29'), { year: 2024, month: 2, day: 29 });
  for (const bad of ['2025-02-29', '2025-13-01', '2025-00-10', '2025-04-31', '2025-4-1', '25-04-01', '2025-04-01T00:00', '', null, undefined, 20250401, '2025-02-00']) {
    assert.equal(D.parseISO(bad), null, String(bad));
  }
});

test('weekdayOf matches known dates (0 = Sunday)', () => {
  assert.equal(D.weekdayOf(2000, 1, 1), 6); // Saturday
  assert.equal(D.weekdayOf(2024, 2, 29), 4); // Thursday
  assert.equal(D.weekdayOf(2026, 11, 1), 0); // Sunday
  assert.equal(D.weekdayOfISO('1999-12-31'), 5); // Friday
  assert.equal(D.weekdayOfISO('nope'), null);
});

test('weekdayOf agrees with the platform Date for every day 1990-2040 (no timezone drift)', () => {
  for (let y = 1990; y <= 2040; y++) {
    for (let m = 1; m <= 12; m++) {
      const n = D.daysInMonth(y, m);
      for (let d = 1; d <= n; d++) {
        const expected = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        assert.equal(D.weekdayOf(y, m, d), expected, y + '-' + m + '-' + d);
      }
    }
  }
});

test('addMonths carries across year boundaries in both directions', () => {
  assert.deepEqual(D.addMonths(2025, 12, 1), { year: 2026, month: 1 });
  assert.deepEqual(D.addMonths(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(D.addMonths(2026, 1, -13), { year: 2024, month: 12 });
  assert.deepEqual(D.addMonths(2026, 6, 30), { year: 2028, month: 12 });
  assert.deepEqual(D.addMonths(2026, 6, 0), { year: 2026, month: 6 });
});

test('stepMonth stops at the supported range', () => {
  assert.equal(D.stepMonth(D.MAX_YEAR, 12, 1), null);
  assert.equal(D.stepMonth(D.MIN_YEAR, 1, -1), null);
  assert.deepEqual(D.stepMonth(2026, 12, 1), { year: 2027, month: 1 });
});

test('weekdayHeadings follow the configured first day', () => {
  assert.deepEqual(D.weekdayHeadings('sun').map((h) => h.short), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.deepEqual(D.weekdayHeadings('mon').map((h) => h.short), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.deepEqual(D.weekdayHeadings('sat').map((h) => h.short), ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  assert.deepEqual(D.weekdayHeadings('garbage').map((h) => h.short)[0], 'Sun', 'unknown value falls back to Sunday');
});

test('buildMonthGrid: no ghost dates, each day exactly once, correct alignment — every month 1990-2040, all week starts', () => {
  for (const ws of ['sun', 'mon', 'sat']) {
    const first = D.WEEK_START[ws];
    for (let y = 1990; y <= 2040; y++) {
      for (let m = 1; m <= 12; m++) {
        const g = D.buildMonthGrid(y, m, ws);
        const n = D.daysInMonth(y, m);
        const days = g.cells.filter(Boolean);

        assert.equal(days.length, n, y + '-' + m + ' day count');
        assert.deepEqual(days.map((c) => c.day), Array.from({ length: n }, (_, i) => i + 1), 'days 1..n in order, once each');
        days.forEach((c) => assert.ok(c.iso.startsWith(D.monthKey(y, m) + '-'), 'only dates of this month: ' + c.iso));

        assert.ok(g.weeks.every((w) => w.length === 7), 'rows are 7 wide');
        assert.equal(g.cells.length % 7, 0);
        assert.equal(g.weeks.length, Math.ceil((g.leadingBlanks + n) / 7));

        // blanks are only at the very start and very end, and carry no data
        const firstDay = g.cells.findIndex(Boolean);
        const lastDay = g.cells.length - 1 - [...g.cells].reverse().findIndex(Boolean);
        assert.equal(firstDay, g.leadingBlanks);
        assert.ok(g.cells.slice(0, firstDay).every((c) => c === null));
        assert.ok(g.cells.slice(lastDay + 1).every((c) => c === null));

        // every day sits in the column that matches its weekday
        g.cells.forEach((c, idx) => {
          if (c) assert.equal((first + (idx % 7)) % 7, c.weekday, c.iso + ' column/weekday (' + ws + ')');
        });
      }
    }
  }
});

test('known layouts: November 2026 starts on a Sunday, February 2026 is a perfect 4-week block', () => {
  const nov = D.buildMonthGrid(2026, 11, 'sun');
  assert.equal(nov.leadingBlanks, 0);
  assert.equal(nov.cells.filter(Boolean).length, 30);
  assert.equal(nov.trailingBlanks, 5);
  assert.equal(nov.weeks.length, 5);

  const feb = D.buildMonthGrid(2026, 2, 'sun'); // 1 Feb 2026 is a Sunday, 28 days
  assert.equal(feb.weeks.length, 4);
  assert.equal(feb.leadingBlanks + feb.trailingBlanks, 0);

  const feb24 = D.buildMonthGrid(2024, 2, 'mon'); // leap year, starts Thursday
  assert.equal(feb24.cells.filter(Boolean).length, 29);
  assert.equal(feb24.leadingBlanks, 3);
  assert.equal(feb24.cells.filter(Boolean).pop().iso, '2024-02-29');
});

test('buildMonthList lists exactly the days of the month', () => {
  const list = D.buildMonthList(2024, 2);
  assert.equal(list.length, 29);
  assert.equal(list[0].iso, '2024-02-01');
  assert.equal(list[28].iso, '2024-02-29');
  assert.equal(list[28].weekdayName, 'Thursday');
  assert.equal(D.buildMonthList(2025, 12).length, 31);
  assert.equal(D.buildMonthList(2025, 2).length, 28);
});

test('grid and list agree on the set of dates', () => {
  for (const [y, m] of [[2024, 2], [2025, 2], [2026, 10], [2026, 12], [2027, 1]]) {
    const fromGrid = D.buildMonthGrid(y, m, 'sat').cells.filter(Boolean).map((c) => c.iso);
    const fromList = D.buildMonthList(y, m).map((c) => c.iso);
    assert.deepEqual(fromGrid, fromList);
  }
});

test('todayParts / todayISO use the injected clock (local calendar parts)', () => {
  const now = new Date(2028, 1, 29, 23, 59, 59); // local 29 Feb 2028
  assert.deepEqual(D.todayParts(now), { year: 2028, month: 2, day: 29 });
  assert.equal(D.todayISO(now), '2028-02-29');
  assert.equal(D.todayISO(new Date(2026, 11, 31)), '2026-12-31');
  assert.equal(D.todayISO(new Date(2027, 0, 1)), '2027-01-01');
});

test('formatting helpers', () => {
  assert.equal(D.formatLongDate('2026-11-05'), 'Thursday, 5 November 2026');
  assert.equal(D.formatLongDate('2026-02-30'), '');
  assert.equal(D.formatMinutes(0), '0m');
  assert.equal(D.formatMinutes(45), '45m');
  assert.equal(D.formatMinutes(120), '2h');
  assert.equal(D.formatMinutes(135), '2h 15m');
  assert.equal(D.formatMinutes(null), '0m');
});
