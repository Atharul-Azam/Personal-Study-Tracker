/* Study Tracker — application wiring: state, navigation, settings, backup/restore flows. */
(function () {
  'use strict';
  var ST = window.ST, h = ST.h, D = window.StudyDates, M = window.StudyModel;

  var resolveReady;
  window.__appReady = new Promise(function (resolve) { resolveReady = resolve; });

  var ZERO_STATS = { studyDays: 0, completedDays: 0, learningPoints: 0, reviewDays: 0, totalMinutes: 0, daysWithDuration: 0 };
  var state = {
    year: 2000, month: 1, selected: null,
    settings: Object.assign({}, M.DEFAULT_SETTINGS),
    info: null,
    cache: new Map(),
    monthSeq: 0,
    monthData: { days: {}, stats: ZERO_STATS }
  };
  var editor = null, sidebar = null;
  var el = {};

  function today() { return D.todayISO(); }
  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ settings
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function resolvedTheme(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    return mq && mq.matches ? 'dark' : 'light';
  }

  function applySettings(s, prev) {
    var root = document.documentElement;
    root.dataset.theme = resolvedTheme(s.theme);
    root.style.setProperty('--ui-font', ST.fontStack(s.uiFont));
    root.style.setProperty('--editor-font', ST.fontStack(s.editorFont));
    root.style.setProperty('--ui-size', s.uiFontSize + 'px');
    root.style.setProperty('--editor-size', s.editorFontSize + 'px');
    if (!prev || prev.theme !== s.theme) { try { window.api.setNativeTheme(s.theme); } catch (e) { /* ignore */ } }

    el.sidebar.hidden = !s.sidebarOpen;
    el.sidebarBtn.setAttribute('aria-expanded', s.sidebarOpen ? 'true' : 'false');
    el.sidebarBtn.setAttribute('aria-label', s.sidebarOpen ? 'Hide settings panel' : 'Show settings panel');
    el.viewToggle.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.view === s.view ? 'true' : 'false'); });
    if (sidebar) sidebar.update(s, state.info);

    if (prev) {
      if (prev.view !== s.view || prev.weekStart !== s.weekStart) renderCal({ scrollToFocus: true });
      if (editor) editor.applySettings();
    }
  }

  function changeSettings(patch) {
    var prev = state.settings;
    var clean = M.sanitizeSettings(patch);
    if (!Object.keys(clean).length) return Promise.resolve();
    state.settings = Object.assign({}, prev, clean);
    applySettings(state.settings, prev);
    return ST.rpc('setSettings', clean).then(function (saved) {
      state.settings = saved;
    }, function (err) {
      ST.toast('Your setting could not be saved: ' + err.message, 'error');
      return ST.rpc('getSettings').then(function (s) { var p = state.settings; state.settings = s; applySettings(s, p); }, function () { /* keep optimistic */ });
    });
  }

  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (state.settings.theme === 'system') applySettings(state.settings, state.settings); });

  // ------------------------------------------------------------------ calendar
  function monthKey() { return D.monthKey(state.year, state.month); }

  function renderTitle() {
    var t = D.MONTH_NAMES[state.month - 1] + ' ' + state.year;
    el.title.textContent = t;
    document.title = 'Study Tracker — ' + t;
  }

  function renderCal(opts) {
    ST.renderCalendar(el.calendar, {
      view: state.settings.view, year: state.year, month: state.month, weekStart: state.settings.weekStart,
      today: today(), selected: state.selected, days: state.monthData.days,
      onSelect: selectDate, scrollToFocus: !!(opts && opts.scrollToFocus), keepScroll: !!(opts && opts.keepScroll)
    });
    ST.renderSummary(el.summary, state.monthData.stats);
  }

  function loadMonth(force) {
    var key = monthKey();
    var seq = ++state.monthSeq;
    var cached = state.cache.get(key);
    state.monthData = cached || { days: {}, stats: ZERO_STATS };
    renderTitle();
    renderCal({ scrollToFocus: true });
    if (cached && !force) return Promise.resolve();
    return ST.rpc('getMonth', state.year, state.month).then(function (data) {
      state.cache.set(key, data);
      if (seq === state.monthSeq) { state.monthData = data; renderCal({ keepScroll: true, scrollToFocus: !force }); }
    }, function (err) {
      ST.toast('Could not load this month: ' + err.message, 'error');
    });
  }

  // Month navigation is coalesced: rapid clicks always land on the final target, never skip a step.
  var navTarget = null, navRunning = false;
  function requestMonth(year, month) {
    if (!D.isValidYearMonth(year, month)) {
      ST.toast('That month is outside the supported range (' + D.MIN_YEAR + '–' + D.MAX_YEAR + ').', 'error');
      return;
    }
    navTarget = { year: year, month: month };
    if (!navRunning) runNav();
  }
  // `navTarget` is the most recently requested month. It stays set until that month is on screen, so
  // further clicks made while a switch is still in flight build on it instead of on the old month.
  function runNav() {
    navRunning = true;
    (function step() {
      var t = navTarget;
      if (!t || (t.year === state.year && t.month === state.month)) { navTarget = null; navRunning = false; return Promise.resolve(); }
      return editor.ensureSafeToLeave().then(function (ok) {
        if (!ok) { navTarget = null; return; }
        var latest = navTarget || t;                       // a newer request may have arrived meanwhile
        state.year = latest.year; state.month = latest.month;
        return loadMonth(false);
      }).then(step, function () { navTarget = null; navRunning = false; });
    })();
  }
  function stepFromCurrent(delta) {
    var base = navTarget || state;
    var r = D.stepMonth(base.year, base.month, delta);
    if (!r) { ST.toast('That month is outside the supported range (' + D.MIN_YEAR + '–' + D.MAX_YEAR + ').', 'error'); return; }
    requestMonth(r.year, r.month);
  }
  function goToday() { var t = D.todayParts(); requestMonth(t.year, t.month); }

  function selectDate(iso) {
    return editor.open(iso).then(function (ok) {
      if (ok) { state.selected = editor.currentDate(); renderCal({ keepScroll: true }); }
    });
  }

  function onSaved(date) {
    var p = D.parseISO(date);
    var key = D.monthKey(p.year, p.month);
    state.cache.delete(key);
    if (key === monthKey()) loadMonth(true);
    refreshInfo();
  }

  var refreshInfo = ST.debounce(function () {
    ST.rpc('getInfo').then(function (info) { state.info = info; sidebar.update(state.settings, info); }, function () { /* non-critical */ });
  }, 400);

  // ------------------------------------------------------------------ month/year picker
  function closePicker() {
    el.picker.hidden = true;
    el.titleBtn.setAttribute('aria-expanded', 'false');
  }
  function openPicker() {
    var py = state.year;
    var yearInput = h('input', { type: 'number', id: 'picker-year', min: String(D.MIN_YEAR), max: String(D.MAX_YEAR), value: String(py), 'aria-label': 'Year' });
    var err = h('p', { class: 'picker-error', id: 'picker-error', role: 'alert' }, '');
    var monthsBox = h('div', { class: 'picker-months', role: 'group', 'aria-label': 'Month' });
    var tp = D.todayParts();

    function readYear() {
      var v = Number(yearInput.value);
      if (!yearInput.value || !isFinite(v) || Math.floor(v) !== v || v < D.MIN_YEAR || v > D.MAX_YEAR) {
        err.textContent = 'Enter a year between ' + D.MIN_YEAR + ' and ' + D.MAX_YEAR + '.';
        return null;
      }
      err.textContent = '';
      return v;
    }
    function paintMonths() {
      monthsBox.textContent = '';
      D.MONTH_NAMES.forEach(function (name, i) {
        monthsBox.appendChild(h('button', {
          type: 'button', dataset: { month: String(i + 1) }, 'aria-current': (py === state.year && i + 1 === state.month) ? 'true' : null,
          class: (py === tp.year && i + 1 === tp.month) ? 'is-today-month' : null,
          onclick: function () { var y = readYear(); if (y === null) return; closePicker(); requestMonth(y, i + 1); el.titleBtn.focus(); }
        }, name.slice(0, 3)));
      });
    }
    function setYear(y) { py = Math.min(D.MAX_YEAR, Math.max(D.MIN_YEAR, y)); yearInput.value = String(py); err.textContent = ''; paintMonths(); }
    yearInput.addEventListener('input', function () { var y = readYear(); if (y !== null) { py = y; paintMonths(); } });
    yearInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); var y = readYear(); if (y !== null) { closePicker(); requestMonth(y, state.month); } }
    });

    el.picker.textContent = '';
    el.picker.appendChild(h('div', { class: 'picker-year' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous year', onclick: function () { setYear((readYear() || py) - 1); } }, ST.svg('M15 6l-6 6 6 6', 18)),
      yearInput,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next year', onclick: function () { setYear((readYear() || py) + 1); } }, ST.svg('M9 6l6 6-6 6', 18))));
    el.picker.appendChild(monthsBox);
    el.picker.appendChild(err);
    paintMonths();

    var r = el.titleBtn.getBoundingClientRect();
    el.picker.style.left = Math.max(8, Math.min(window.innerWidth - 296, r.left + r.width / 2 - 140)) + 'px';
    el.picker.hidden = false;
    el.titleBtn.setAttribute('aria-expanded', 'true');
    yearInput.focus(); yearInput.select();
  }
  function togglePicker() { if (el.picker.hidden) openPicker(); else closePicker(); }

  // ------------------------------------------------------------------ backup / restore
  function describeFail(r) { return (r && r.message) || 'The action could not be completed.'; }

  function exportFile(kind) {
    return editor.flush().then(function (ok) {
      if (!ok) { ST.toast('Fix the unsaved changes first, then export again.', 'error'); return; }
      return window.api.exportFile(kind).then(function (r) {
        if (!r.ok) return ST.alertModal('Export failed', describeFail(r));
        if (r.canceled) return;
        ST.toast((kind === 'csv' ? 'Summary exported to ' : 'All records exported to ') + r.path, 'ok', 6000);
      });
    });
  }

  function createBackup() {
    return editor.flush().then(function (ok) {
      if (!ok) { ST.toast('Fix the unsaved changes first, then create the backup.', 'error'); return; }
      return ST.rpc('createBackup').then(function (r) {
        ST.toast('Backup created: ' + r.file, 'ok', 9000, { label: 'Show', onClick: function () { window.api.showFile(r.file); } });
      }, function (err) { return ST.alertModal('Backup failed', err.message); });
    });
  }

  function importBackup() {
    return editor.ensureSafeToLeave().then(function (ok) {
      if (!ok) return;
      return window.api.pickImport().then(function (r) {
        if (!r.ok) return ST.alertModal('That file can\'t be restored', describeFail(r));
        if (r.canceled) return;
        var a = r.analysis;
        if (!a.ok) return ST.alertModal('That file can\'t be restored', 'This is not a usable Study Tracker backup, so nothing was changed.', a.errors);
        return chooseRestore(a, r.fileName);
      });
    });
  }

  function chooseRestore(a, fileName) {
    var s = a.summary;
    var mode = 'skip';
    var includeSettings = false;
    var options = [
      ['skip', 'Add only days that don\'t exist yet', 'Your current days stay exactly as they are.' + (s.overlapping ? ' ' + s.overlapping + ' day(s) in the backup already exist and will be skipped.' : '')],
      ['overwrite', 'Overwrite days that are in the backup', 'Days in the backup replace your versions of the same dates. Other days are untouched. A safety backup is made first.'],
      ['replace', 'Replace everything with the backup', 'All current days are removed first, so your data will match the backup. A safety backup is made first.']
    ];
    if (s.overlapping === 0) options = options.slice(0, 1).concat(options.slice(2));

    var radios = h('div', { role: 'radiogroup', 'aria-label': 'How to restore' });
    function paintRadios() {
      radios.textContent = '';
      options.forEach(function (o) {
        var input = h('input', { type: 'radio', name: 'restore-mode', value: o[0], checked: mode === o[0], onchange: function () { mode = o[0]; paintRadios(); } });
        radios.appendChild(h('label', { class: 'radio' + (mode === o[0] ? ' sel' : ''), dataset: { mode: o[0] } }, input, h('span', null, h('b', null, o[1]), h('small', null, o[2]))));
      });
    }
    paintRadios();

    var body = [
      h('p', null, 'File: ', h('b', null, fileName || 'backup'), s.exportedAt ? ' (exported ' + new Date(s.exportedAt).toLocaleString() + ')' : ''),
      h('div', { class: 'stat-line' },
        h('span', null, h('b', null, String(s.entries)), ' days'), h('span', null, h('b', null, String(s.points)), ' learning points'),
        h('span', null, h('b', null, String(s.newDates)), ' new'), h('span', null, h('b', null, String(s.overlapping)), ' already here')),
      radios
    ];
    if (s.hasSettings) {
      body.push(h('div', { class: 'check' }, h('input', { type: 'checkbox', id: 'restore-settings', onchange: function (e) { includeSettings = e.target.checked; } }), h('label', { for: 'restore-settings' }, 'Also restore settings (theme, fonts, view)')));
    }

    return ST.openModal({
      title: 'Restore from backup', body: body, dismissValue: 'cancel',
      actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Restore', kind: 'primary', value: 'go' }]
    }).then(function (choice) {
      if (choice !== 'go') return;
      if (mode === 'replace') {
        return ST.openModal({
          title: 'Replace all current data?', dismissValue: 'no',
          body: h('p', null, 'Your ', h('b', null, String(s.currentEntries)), ' current day(s) will be replaced by the ', h('b', null, String(s.entries)), ' day(s) in the backup. A safety backup of your current data is created first.'),
          actions: [{ label: 'Cancel', value: 'no' }, { label: 'Replace everything', kind: 'danger', value: 'yes' }]
        }).then(function (c) { return c === 'yes' ? doRestore(a.token, mode, includeSettings) : undefined; });
      }
      return doRestore(a.token, mode, includeSettings);
    });
  }

  function doRestore(token, mode, includeSettings) {
    return ST.rpc('applyBackup', token, mode, includeSettings).then(function (res) {
      state.cache.clear();
      var prevSettings = state.settings;
      if (includeSettings) { state.settings = res.settings; applySettings(state.settings, prevSettings); }
      return Promise.all([loadMonth(true), editor.reload(), ST.rpc('getInfo').then(function (i) { state.info = i; sidebar.update(state.settings, i); })]).then(function () {
        var msg = 'Restore finished: ' + res.added + ' added, ' + res.overwritten + ' overwritten, ' + res.skipped + ' skipped.';
        ST.toast(msg, 'ok', 9000, res.safetyBackup ? { label: 'Show safety backup', onClick: function () { window.api.showFile(res.safetyBackup); } } : undefined);
      });
    }, function (err) { return ST.alertModal('Restore failed', err.message + ' Nothing was changed.'); });
  }

  // ------------------------------------------------------------------ boot
  function wire() {
    el.sidebarBtn.addEventListener('click', function () { changeSettings({ sidebarOpen: !state.settings.sidebarOpen }); });
    $('btn-prev').addEventListener('click', function () { stepFromCurrent(-1); });
    $('btn-next').addEventListener('click', function () { stepFromCurrent(1); });
    $('btn-today').addEventListener('click', goToday);
    el.titleBtn.addEventListener('click', function (e) { e.stopPropagation(); togglePicker(); });
    el.viewToggle.querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { changeSettings({ view: b.dataset.view }); }); });

    document.addEventListener('mousedown', function (e) {
      if (!el.picker.hidden && !el.picker.contains(e.target) && !el.titleBtn.contains(e.target)) closePicker();
    });

    document.addEventListener('keydown', function (e) {
      if (ST.isModalOpen()) return;
      var mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); editor.saveNow(); return; }
      if (mod && e.key === ',') { e.preventDefault(); changeSettings({ sidebarOpen: !state.settings.sidebarOpen }); return; }
      if (e.key === 'Escape' && !el.picker.hidden) { closePicker(); el.titleBtn.focus(); return; }
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
      if (mod || e.altKey) return;
      if (e.key === 'PageUp') { e.preventDefault(); stepFromCurrent(-1); }
      else if (e.key === 'PageDown') { e.preventDefault(); stepFromCurrent(1); }
      else if (e.key === 't' || e.key === 'T') { e.preventDefault(); goToday(); }
    });

    window.addEventListener('beforeunload', function (e) {
      if (editor && editor.isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
    window.api.onCloseRequested(function () {
      editor.ensureSafeToLeave().then(function (ok) { window.api.respondToClose(ok); }, function () { window.api.respondToClose(false); });
    });
  }

  function fatal(message) {
    el.calendar.textContent = '';
    el.calendar.appendChild(h('div', { class: 'ed-empty' }, h('h2', null, 'Study Tracker could not start'), h('p', null, message)));
  }

  function boot() {
    el.sidebar = $('sidebar'); el.sidebarBtn = $('btn-sidebar'); el.title = $('title-text'); el.titleBtn = $('btn-title');
    el.picker = $('picker'); el.viewToggle = $('view-toggle'); el.calendar = $('calendar'); el.summary = $('summary'); el.editor = $('editor');

    // Start inside a promise chain so that ANY failure (including a missing preload bridge, which
    // makes ST.rpc throw synchronously) ends in the error handler below and settles __appReady.
    return Promise.resolve().then(function () {
      if (!window.api || typeof window.api.rpc !== 'function') {
        throw new Error('The connection to the application core is missing (the preload script did not load). Please reinstall Study Tracker.');
      }
      return Promise.all([ST.rpc('getSettings'), ST.rpc('getInfo')]);
    }).then(function (r) {
      state.settings = r[0]; state.info = r[1];
      var t = D.todayParts();
      state.year = t.year; state.month = t.month;

      sidebar = ST.createSidebar(el.sidebar, {
        onChange: changeSettings,
        actions: {
          openFolder: function () { window.api.openDataFolder().then(function (res) { if (!res.ok) ST.toast(describeFail(res), 'error'); }); },
          exportJson: function () { exportFile('json'); },
          exportCsv: function () { exportFile('csv'); },
          importBackup: importBackup,
          createBackup: createBackup
        }
      });
      editor = ST.createEditor(el.editor, {
        getSettings: function () { return state.settings; },
        todayISO: today,
        onSaved: onSaved,
        onClose: function () { editor.close().then(function (ok) { if (ok) { state.selected = null; renderCal({ keepScroll: true }); } }); }
      });
      applySettings(state.settings, null);
      wire();
      return loadMonth(false).then(function () { return selectDate(today()); });
    }).then(function () {
      resolveReady(true);
    }, function (err) {
      try { fatal(err && err.message ? err.message : 'Unknown error.'); } catch (_) { /* never leave __appReady pending */ }
      resolveReady(false);
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
  // test hook (read-only view of state; no write access)
  window.__studyState = function () { return { year: state.year, month: state.month, selected: state.selected, settings: state.settings }; };
})();
