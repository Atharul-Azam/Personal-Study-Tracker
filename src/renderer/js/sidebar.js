/* Study Tracker — collapsible settings sidebar.
   Built once; `update()` pushes new values into the existing controls so focus is never lost. */
(function () {
  'use strict';
  var ST = window.ST, h = ST.h, M = window.StudyModel;

  var THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'System' };

  function createSidebar(root, deps) {
    var controls = {};
    var info = null;

    function section(title, children) { return h('section', { class: 'side-sec' }, h('h3', null, title), children); }

    function segmented(key, options) {
      var wrap = h('div', { class: 'seg', role: 'group', 'aria-label': options.label });
      options.items.forEach(function (it) {
        wrap.appendChild(h('button', { type: 'button', dataset: { setting: key, value: it[0] }, 'aria-pressed': 'false', onclick: function () { deps.onChange(patch(key, it[0])); } }, it[1]));
      });
      controls[key] = function (v) { wrap.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.value === v ? 'true' : 'false'); }); };
      return wrap;
    }

    function patch(key, value) { var p = {}; p[key] = value; return p; }

    function select(key, id, label, items) {
      var sel = h('select', { id: id, onchange: function (e) { deps.onChange(patch(key, e.target.value)); } },
        items.map(function (it) { return h('option', { value: it[0] }, it[1]); }));
      controls[key] = function (v) { sel.value = v; };
      return h('div', { class: 'field' }, h('label', { for: id }, label), sel);
    }

    function fontSelect(key, id, label) {
      var sel = h('select', { id: id, onchange: function (e) { deps.onChange(patch(key, e.target.value)); } });
      var installed = ST.installedFonts();
      controls[key] = function (v) {
        sel.textContent = '';
        sel.appendChild(h('option', { value: 'system' }, 'System default'));
        installed.forEach(function (n) { sel.appendChild(h('option', { value: n }, n)); });
        if (v !== 'system' && installed.indexOf(v) === -1) sel.appendChild(h('option', { value: v }, v + ' (not installed here)'));
        sel.value = v;
      };
      return h('div', { class: 'field' }, h('label', { for: id }, label), sel);
    }

    function sizeStepper(key, label, id) {
      var out = h('output', { id: id, 'aria-live': 'polite' }, '');
      var cur = 14;
      function bump(d) { deps.onChange(patch(key, Math.min(M.FONT_SIZE_MAX, Math.max(M.FONT_SIZE_MIN, cur + d)))); }
      var box = h('div', { class: 'stepper', role: 'group', 'aria-label': label },
        h('button', { type: 'button', 'aria-label': 'Decrease ' + label.toLowerCase(), dataset: { step: '-1', setting: key }, onclick: function () { bump(-1); } }, '−'),
        out,
        h('button', { type: 'button', 'aria-label': 'Increase ' + label.toLowerCase(), dataset: { step: '1', setting: key }, onclick: function () { bump(1); } }, '+'));
      controls[key] = function (v) { cur = v; out.textContent = v + ' px'; };
      return box;
    }

    function checkbox(key, id, label, hint) {
      var cb = h('input', { type: 'checkbox', id: id, onchange: function (e) { deps.onChange(patch(key, e.target.checked)); } });
      controls[key] = function (v) { cb.checked = !!v; };
      return h('div', null, h('div', { class: 'check' }, cb, h('label', { for: id }, label)), hint ? h('p', { class: 'hint' }, hint) : null);
    }

    var preview = h('p', { class: 'hint ed-text', id: 'font-preview' }, 'Preview: The quick brown fox — আমি বাংলা পড়ি ১২৩');

    // ---- build ----
    var dataBox = h('div', { id: 'data-info' });
    var counts = h('p', { class: 'hint', id: 'data-counts' }, '');
    var pathEl = h('code', { class: 'path', id: 'data-path' }, '');
    var backupPathEl = h('code', { class: 'path', id: 'backup-path' }, '');

    root.appendChild(section('Appearance', [
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Theme'), segmented('theme', { label: 'Theme', items: [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']] }))
    ]));

    root.appendChild(section('Fonts', [
      fontSelect('uiFont', 'set-ui-font', 'Interface font'),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Interface size'), sizeStepper('uiFontSize', 'Interface size', 'out-ui-size')),
      fontSelect('editorFont', 'set-editor-font', 'Journal editor font'),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Journal editor size'), sizeStepper('editorFontSize', 'Journal editor size', 'out-editor-size')),
      preview,
      h('div', { class: 'field-row' }, h('button', { type: 'button', class: 'btn small', id: 'reset-fonts', onclick: function () {
        deps.onChange({ uiFont: 'system', uiFontSize: M.DEFAULT_SETTINGS.uiFontSize, editorFont: 'system', editorFontSize: M.DEFAULT_SETTINGS.editorFontSize });
      } }, 'Reset fonts')),
      h('p', { class: 'hint' }, 'Only fonts installed on this computer are listed. Bangla and other Unicode text always has a fallback font.')
    ]));

    root.appendChild(section('Calendar', [
      select('view', 'set-view', 'Calendar view (remembered)', [['grid', 'Grid'], ['list', 'List']]),
      select('weekStart', 'set-week-start', 'First day of the week', [['sat', 'Saturday'], ['sun', 'Sunday'], ['mon', 'Monday']]),
      select('listStyle', 'set-list-style', 'Learning log style', [['numbers', 'Numbered list'], ['bullets', 'Bullet points'], ['checklist', 'Checklist']])
    ]));

    root.appendChild(section('General', [
      checkbox('autosave', 'set-autosave', 'Save automatically', 'When off, use Ctrl+S; you are asked before unsaved changes would be lost.')
    ]));

    root.appendChild(section('Data & backup', [
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Your data is stored only on this computer:'), pathEl, counts),
      h('div', { class: 'btn-stack' },
        h('button', { type: 'button', class: 'btn', id: 'btn-open-folder', onclick: function () { deps.actions.openFolder(); } }, 'Open data folder'),
        h('button', { type: 'button', class: 'btn', id: 'btn-export-json', onclick: function () { deps.actions.exportJson(); } }, 'Export all records (JSON)…'),
        h('button', { type: 'button', class: 'btn', id: 'btn-import-json', onclick: function () { deps.actions.importBackup(); } }, 'Import / restore (JSON)…'),
        h('button', { type: 'button', class: 'btn', id: 'btn-create-backup', onclick: function () { deps.actions.createBackup(); } }, 'Create full local backup'),
        h('button', { type: 'button', class: 'btn', id: 'btn-export-csv', onclick: function () { deps.actions.exportCsv(); } }, 'Export summary (CSV)…')),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Local backups are saved in:'), backupPathEl),
      h('p', { class: 'hint' }, 'No account, no cloud, no telemetry. Restoring never overwrites anything without asking first.')
    ]));

    root.appendChild(section('Keyboard shortcuts', [
      h('ul', { class: 'shortcuts' },
        [['Save now', 'Ctrl+S'], ['New learning point', 'Ctrl+Enter'], ['Move point up / down', 'Alt+↑ / ↓'], ['Previous / next month', 'PgUp / PgDn'], ['Go to today', 'T'], ['Settings panel', 'Ctrl+,']].map(function (r) {
          return h('li', null, h('span', null, r[0]), h('span', { class: 'kbd' }, r[1]));
        }))
    ]));

    var about = h('p', { class: 'hint', id: 'about' }, '');
    root.appendChild(section('About', [about]));

    function update(settings, newInfo) {
      if (newInfo) info = newInfo;
      Object.keys(controls).forEach(function (k) { if (k in settings) controls[k](settings[k]); });
      if (info) {
        pathEl.textContent = info.dbFile;
        backupPathEl.textContent = info.backupDir;
        counts.textContent = info.counts.entries + (info.counts.entries === 1 ? ' day' : ' days') + ' with notes · ' + info.counts.points + (info.counts.points === 1 ? ' learning point' : ' learning points');
        about.textContent = 'Study Tracker ' + info.appVersion + ' — works fully offline.';
      }
    }

    return { update: update };
  }

  ST.createSidebar = createSidebar;
})();
