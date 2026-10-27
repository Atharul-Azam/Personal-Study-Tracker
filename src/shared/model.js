/*
 * Study Tracker — entry/settings validation shared by the store, the backup
 * importer and the tests. Pure functions, no Node or DOM APIs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./dates.js'));
  else root.StudyModel = factory(root.StudyDates);
})(typeof self !== 'undefined' ? self : this, function (Dates) {
  'use strict';

  var STATUSES = ['not_started', 'in_progress', 'completed'];
  var STATUS_LABELS = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };

  var LIMITS = {
    maxPoints: 500,
    maxPointChars: 20000,
    maxReviewChars: 200000,
    maxTags: 20,
    maxTagChars: 40,
    maxMinutes: 24 * 60 * 31 // generous upper bound, catches typos like 99999999
  };

  var THEMES = ['light', 'dark', 'system'];
  var VIEWS = ['grid', 'list'];
  var WEEK_STARTS = ['sat', 'sun', 'mon'];
  var LIST_STYLES = ['numbers', 'bullets', 'checklist'];

  var DEFAULT_SETTINGS = {
    theme: 'system',
    uiFont: 'system',
    uiFontSize: 14,
    editorFont: 'system',
    editorFontSize: 15,
    view: 'grid',
    weekStart: 'sun',
    autosave: true,
    listStyle: 'numbers',
    sidebarOpen: false
  };

  var FONT_SIZE_MIN = 11, FONT_SIZE_MAX = 28;

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function clampInt(v, min, max, fallback) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n)) return fallback;
    n = Math.round(n);
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Validates a single journal entry coming from the UI or a backup file.
   * Returns { ok: true, entry } with a cleaned copy, or { ok: false, errors: [...] }.
   * Nothing is silently truncated: oversize or malformed values are errors.
   */
  function validateEntry(input) {
    var errors = [];
    if (!isPlainObject(input)) return { ok: false, errors: ['Entry is not an object.'] };

    var parsed = Dates.parseISO(input.date);
    if (!parsed) errors.push('Invalid date "' + String(input.date) + '" (expected a real date as YYYY-MM-DD).');
    else if (parsed.year < Dates.MIN_YEAR || parsed.year > Dates.MAX_YEAR) {
      errors.push('Date ' + input.date + ' is outside the supported years ' + Dates.MIN_YEAR + '-' + Dates.MAX_YEAR + '.');
    }

    var points = [];
    if (input.points !== undefined && input.points !== null) {
      if (!Array.isArray(input.points)) errors.push('"points" must be a list.');
      else if (input.points.length > LIMITS.maxPoints) errors.push('Too many learning points (max ' + LIMITS.maxPoints + ').');
      else {
        input.points.forEach(function (p, i) {
          var text, done = false;
          if (typeof p === 'string') text = p;
          else if (isPlainObject(p) && typeof p.text === 'string') { text = p.text; done = p.done === true; }
          else { errors.push('Learning point ' + (i + 1) + ' is not valid text.'); return; }
          if (text.length > LIMITS.maxPointChars) { errors.push('Learning point ' + (i + 1) + ' is too long.'); return; }
          if (text.trim() === '') return; // blank rows are not stored
          points.push({ text: text.replace(/\s+$/, ''), done: done });
        });
      }
    }

    var review = '';
    if (input.review !== undefined && input.review !== null) {
      if (typeof input.review !== 'string') errors.push('"review" must be text.');
      else if (input.review.length > LIMITS.maxReviewChars) errors.push('Personal review is too long.');
      else review = input.review.trim() === '' ? '' : input.review;
    }

    var durationMin = null;
    if (input.durationMin !== undefined && input.durationMin !== null && input.durationMin !== '') {
      var d = Number(input.durationMin);
      if (!isFinite(d) || Math.floor(d) !== d || d < 0 || d > LIMITS.maxMinutes) {
        errors.push('Study duration must be a whole number of minutes between 0 and ' + LIMITS.maxMinutes + '.');
      } else durationMin = d;
    }

    var status = 'not_started';
    if (input.status !== undefined && input.status !== null) {
      if (STATUSES.indexOf(input.status) === -1) errors.push('Unknown status "' + String(input.status) + '".');
      else status = input.status;
    }

    var tags = [];
    if (input.tags !== undefined && input.tags !== null) {
      if (!Array.isArray(input.tags)) errors.push('"tags" must be a list.');
      else {
        var seen = {};
        input.tags.forEach(function (t) {
          if (typeof t !== 'string') { errors.push('A tag is not text.'); return; }
          var tag = t.trim().replace(/\s+/g, ' ');
          if (!tag) return;
          if (tag.length > LIMITS.maxTagChars) { errors.push('Tag "' + tag.slice(0, 20) + '…" is too long.'); return; }
          var key = tag.toLowerCase();
          if (seen[key]) return;
          seen[key] = true;
          tags.push(tag);
        });
        if (tags.length > LIMITS.maxTags) errors.push('Too many tags (max ' + LIMITS.maxTags + ').');
      }
    }

    var rating = null;
    if (input.rating !== undefined && input.rating !== null && input.rating !== '') {
      var r = Number(input.rating);
      if (!isFinite(r) || Math.floor(r) !== r || r < 1 || r > 5) errors.push('Rating must be a whole number from 1 to 5.');
      else rating = r;
    }

    if (errors.length) return { ok: false, errors: errors };
    return {
      ok: true,
      entry: {
        date: input.date,
        points: points,
        review: review,
        durationMin: durationMin,
        status: status,
        tags: tags,
        rating: rating
      }
    };
  }

  /** An entry with nothing meaningful in it is not stored at all. */
  function isEmptyEntry(e) {
    return !e.points.length && !e.review && !e.durationMin && e.status === 'not_started' && !e.tags.length && !e.rating;
  }

  function blankEntry(date) {
    return { date: date, points: [], review: '', durationMin: null, status: 'not_started', tags: [], rating: null };
  }

  /**
   * "Study day" rule (also shown in the README): a date counts as a study day when it
   * has at least one learning point, OR its status is In progress/Completed, OR it has
   * a study duration above zero. Merely opening a date never creates anything.
   * "Completed" days are only those whose status the user set to Completed.
   */
  function isStudyDay(s) {
    return (s.points || 0) > 0 || s.status === 'in_progress' || s.status === 'completed' || (s.durationMin || 0) > 0;
  }

  /**
   * Cleans a (partial) settings object. Unknown keys and invalid values are DROPPED, never
   * replaced with defaults, so a bad value in an update can't clobber what the user already has.
   * Numbers are clamped into their allowed range. Callers merge the result over the defaults.
   */
  function sanitizeSettings(input) {
    var out = {};
    var src = isPlainObject(input) ? input : {};
    function oneOf(key, allowed) { if (allowed.indexOf(src[key]) !== -1) out[key] = src[key]; }
    function font(key) {
      var v = src[key];
      if (typeof v === 'string' && v.length > 0 && v.length <= 80 && !/[;{}<>\n\r\\]/.test(v)) out[key] = v;
    }
    function size(key) {
      var n = clampInt(src[key], FONT_SIZE_MIN, FONT_SIZE_MAX, null);
      if (n !== null) out[key] = n;
    }
    function bool(key) { if (typeof src[key] === 'boolean') out[key] = src[key]; }
    oneOf('theme', THEMES);
    font('uiFont');
    size('uiFontSize');
    font('editorFont');
    size('editorFontSize');
    oneOf('view', VIEWS);
    oneOf('weekStart', WEEK_STARTS);
    bool('autosave');
    oneOf('listStyle', LIST_STYLES);
    bool('sidebarOpen');
    return out;
  }

  return {
    STATUSES: STATUSES,
    STATUS_LABELS: STATUS_LABELS,
    LIMITS: LIMITS,
    THEMES: THEMES,
    VIEWS: VIEWS,
    WEEK_STARTS: WEEK_STARTS,
    LIST_STYLES: LIST_STYLES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    FONT_SIZE_MIN: FONT_SIZE_MIN,
    FONT_SIZE_MAX: FONT_SIZE_MAX,
    validateEntry: validateEntry,
    isEmptyEntry: isEmptyEntry,
    blankEntry: blankEntry,
    isStudyDay: isStudyDay,
    sanitizeSettings: sanitizeSettings
  };
});
