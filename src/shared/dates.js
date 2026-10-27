/*
 * Study Tracker — date and calendar logic.
 *
 * Pure functions only (no DOM, no Node APIs) so the exact same file runs in
 * the Electron renderer, the main process and the automated tests.
 *
 * Conventions used everywhere in the app:
 *   - month is 1..12 (NOT 0..11)
 *   - weekday is 0..6 with 0 = Sunday
 *   - a "date id" is the ISO string YYYY-MM-DD, built from calendar parts only,
 *     never from a timezone-dependent Date -> toISOString() round trip.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudyDates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_YEAR = 1900;
  var MAX_YEAR = 2200;

  var MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  var WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Settings value -> weekday index of the first column.
  var WEEK_START = { sun: 0, mon: 1, sat: 6 };

  function pad(n, width) {
    var s = String(n);
    while (s.length < (width || 2)) s = '0' + s;
    return s;
  }

  function isInt(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
  }

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  function isValidYearMonth(year, month) {
    return isInt(year) && isInt(month) && year >= MIN_YEAR && year <= MAX_YEAR && month >= 1 && month <= 12;
  }

  function daysInMonth(year, month) {
    if (!isInt(year) || !isInt(month) || month < 1 || month > 12) {
      throw new RangeError('Invalid year/month: ' + year + '/' + month);
    }
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    return (month === 4 || month === 6 || month === 9 || month === 11) ? 30 : 31;
  }

  function toISO(year, month, day) {
    return pad(year, 4) + '-' + pad(month) + '-' + pad(day);
  }

  /** Strictly parses YYYY-MM-DD. Returns {year, month, day} or null if it is not a real calendar date. */
  function parseISO(str) {
    if (typeof str !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (!m) return null;
    var year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10);
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    return { year: year, month: month, day: day };
  }

  function isValidISO(str) {
    return parseISO(str) !== null;
  }

  /** 0 = Sunday ... 6 = Saturday. Uses UTC arithmetic so the local timezone / DST can never shift the result. */
  function weekdayOf(year, month, day) {
    var d = new Date(0);
    d.setUTCFullYear(year, month - 1, day);
    return d.getUTCDay();
  }

  function weekdayOfISO(iso) {
    var p = parseISO(iso);
    return p ? weekdayOf(p.year, p.month, p.day) : null;
  }

  function monthKey(year, month) {
    return pad(year, 4) + '-' + pad(month);
  }

  /** First and last date id of a month, handy for range queries. */
  function monthRange(year, month) {
    return { start: toISO(year, month, 1), end: toISO(year, month, daysInMonth(year, month)) };
  }

  /** Moves by `delta` months, carrying across year boundaries. Does not clamp. */
  function addMonths(year, month, delta) {
    var index = year * 12 + (month - 1) + delta;
    var y = Math.floor(index / 12);
    return { year: y, month: index - y * 12 + 1 };
  }

  /** Same as addMonths but returns null when the result leaves the supported range. */
  function stepMonth(year, month, delta) {
    var r = addMonths(year, month, delta);
    return isValidYearMonth(r.year, r.month) ? r : null;
  }

  function weekStartIndex(weekStart) {
    return Object.prototype.hasOwnProperty.call(WEEK_START, weekStart) ? WEEK_START[weekStart] : 0;
  }

  /** Column headings in display order for the chosen first day of the week. */
  function weekdayHeadings(weekStart) {
    var first = weekStartIndex(weekStart);
    var out = [];
    for (var i = 0; i < 7; i++) {
      var w = (first + i) % 7;
      out.push({ weekday: w, short: WEEKDAY_SHORT[w], long: WEEKDAY_NAMES[w] });
    }
    return out;
  }

  /**
   * Builds the month grid.
   *
   * `weeks` is an array of rows with exactly 7 entries each. An entry is either a
   * day object {iso, day, weekday} or `null` for a blank alignment cell. Blank
   * cells never carry a date: there are no "ghost" days from adjacent months.
   */
  function buildMonthGrid(year, month, weekStart) {
    var total = daysInMonth(year, month);
    var first = weekStartIndex(weekStart);
    var leading = (weekdayOf(year, month, 1) - first + 7) % 7;
    var cells = [];
    var i;
    for (i = 0; i < leading; i++) cells.push(null);
    for (var day = 1; day <= total; day++) {
      cells.push({ iso: toISO(year, month, day), day: day, weekday: weekdayOf(year, month, day) });
    }
    var trailing = (7 - (cells.length % 7)) % 7;
    for (i = 0; i < trailing; i++) cells.push(null);

    var weeks = [];
    for (i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return {
      year: year,
      month: month,
      daysInMonth: total,
      leadingBlanks: leading,
      trailingBlanks: trailing,
      cells: cells,
      weeks: weeks
    };
  }

  /** The vertical list: one entry per date of the month, nothing else. */
  function buildMonthList(year, month) {
    var total = daysInMonth(year, month);
    var out = [];
    for (var day = 1; day <= total; day++) {
      var w = weekdayOf(year, month, day);
      out.push({ iso: toISO(year, month, day), day: day, weekday: w, weekdayName: WEEKDAY_NAMES[w] });
    }
    return out;
  }

  /** Today's calendar parts from the local clock. `now` can be injected for tests. */
  function todayParts(now) {
    var d = now || new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }

  function todayISO(now) {
    var t = todayParts(now);
    return toISO(t.year, t.month, t.day);
  }

  /** "Thursday, 5 November 2026" */
  function formatLongDate(iso) {
    var p = parseISO(iso);
    if (!p) return '';
    return WEEKDAY_NAMES[weekdayOf(p.year, p.month, p.day)] + ', ' + p.day + ' ' + MONTH_NAMES[p.month - 1] + ' ' + p.year;
  }

  /** 135 -> "2h 15m", 45 -> "45m", 120 -> "2h" */
  function formatMinutes(total) {
    if (!isInt(total) || total <= 0) return '0m';
    var h = Math.floor(total / 60), m = total % 60;
    if (h === 0) return m + 'm';
    return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
  }

  return {
    MIN_YEAR: MIN_YEAR,
    MAX_YEAR: MAX_YEAR,
    MONTH_NAMES: MONTH_NAMES,
    WEEKDAY_NAMES: WEEKDAY_NAMES,
    WEEKDAY_SHORT: WEEKDAY_SHORT,
    WEEK_START: WEEK_START,
    isLeapYear: isLeapYear,
    isValidYearMonth: isValidYearMonth,
    daysInMonth: daysInMonth,
    toISO: toISO,
    parseISO: parseISO,
    isValidISO: isValidISO,
    weekdayOf: weekdayOf,
    weekdayOfISO: weekdayOfISO,
    monthKey: monthKey,
    monthRange: monthRange,
    addMonths: addMonths,
    stepMonth: stepMonth,
    weekdayHeadings: weekdayHeadings,
    buildMonthGrid: buildMonthGrid,
    buildMonthList: buildMonthList,
    todayParts: todayParts,
    todayISO: todayISO,
    formatLongDate: formatLongDate,
    formatMinutes: formatMinutes
  };
});
