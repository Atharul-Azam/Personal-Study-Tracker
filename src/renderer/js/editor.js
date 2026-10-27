/* Study Tracker — the daily journal editor.
 *
 * Data-safety rules implemented here:
 *  - edits are saved after a short debounce (autosave), or on Ctrl+S / navigation;
 *  - saves are serialized, so two saves can never race and overwrite each other;
 *  - a save always writes ONE date (the one the editor was opened on);
 *  - leaving a date / month / the app first flushes pending edits; if that fails, or
 *    autosave is off, the user is asked — changes are never silently discarded.
 */
(function () {
  'use strict';
  var ST = window.ST, h = ST.h, D = window.StudyDates, M = window.StudyModel;

  var SAVE_DEBOUNCE_MS = 700;
  var keySeq = 0;
  function newKey() { keySeq += 1; return 'p' + keySeq; }

  function splitTags(text) {
    var seen = {};
    return String(text || '').split(/[,;]/).map(function (t) { return t.trim().replace(/\s+/g, ' '); }).filter(function (t) {
      var k = t.toLowerCase();
      if (!t || seen[k]) return false;   // same rule as the database layer: case-insensitive de-duplication
      seen[k] = true;
      return true;
    });
  }

  function createEditor(root, deps) {
    var st = emptyState();
    var timer = null;
    var chain = Promise.resolve();
    var openSeq = 0;
    var drag = null;
    var metaOpenPref = false;
    var refs = {};
    var lastDeleted = null;

    function emptyState() {
      return { date: null, points: [], review: '', durationMin: '', status: 'not_started', tags: '', rating: null, dirty: false, rev: 0, state: 'saved', stateMsg: '' };
    }
    function settings() { return deps.getSettings(); }

    // ---------- save state ----------
    var STATE_TEXT = { saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved changes', error: 'Not saved' };
    function setState(state, msg) {
      st.state = state;
      st.stateMsg = msg || '';
      if (refs.save) {
        refs.save.dataset.state = state;
        refs.saveText.textContent = STATE_TEXT[state] + (state === 'unsaved' && !settings().autosave ? ' (Ctrl+S to save)' : '');
        refs.save.title = msg || '';
      }
    }

    function toPayload() {
      return {
        date: st.date,
        points: st.points.map(function (p) { return { text: p.text, done: p.done }; }),
        review: st.review,
        durationMin: st.durationMin === '' ? null : Number(st.durationMin),
        status: st.status,
        tags: splitTags(st.tags),
        rating: st.rating
      };
    }

    function markDirty() {
      st.rev += 1;
      st.dirty = true;
      setState('unsaved');
      updateMetaSummary();
      if (settings().autosave) schedule();
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(function () { timer = null; save(); }, SAVE_DEBOUNCE_MS);
    }

    function save() {
      clearTimeout(timer);
      timer = null;
      chain = chain.then(doSave, doSave);
      return chain;
    }
    function doSave() {
      if (!st.date || !st.dirty) return Promise.resolve(true);
      var rev = st.rev, date = st.date;
      var payload = toPayload();
      setState('saving');
      return ST.rpc('saveEntry', payload).then(function () {
        if (st.date === date) {
          if (st.rev === rev) { st.dirty = false; setState('saved'); }
          else { setState('unsaved'); if (settings().autosave) schedule(); }
        }
        deps.onSaved(date);
        return true;
      }, function (err) {
        if (st.date === date) setState('error', err.message);
        ST.toast('Could not save ' + D.formatLongDate(date) + ': ' + err.message, 'error');
        return false;
      });
    }

    /** Saves until nothing is pending. Resolves false if a save failed. */
    function flush() {
      return (function loop() {
        return chain.then(function () {
          if (!st.date || !st.dirty) return true;
          return save().then(function (ok) { return ok ? loop() : false; });
        });
      })();
    }

    function ensureSafeToLeave() {
      return chain.then(function () {
        if (!st.date || !st.dirty) return true;
        if (settings().autosave) {
          return flush().then(function (ok) {
            if (ok) return true;
            return ST.openModal({
              title: 'Your changes could not be saved',
              body: h('p', null, st.stateMsg || 'Saving failed.', ' If you continue, the edits to ' + D.formatLongDate(st.date) + ' that were not saved will be lost.'),
              actions: [{ label: 'Keep editing', kind: 'primary', value: 'stay' }, { label: 'Discard changes', kind: 'danger', value: 'discard' }],
              dismissValue: 'stay'
            }).then(function (c) { if (c === 'discard') { st.dirty = false; return true; } return false; });
          });
        }
        return ST.openModal({
          title: 'Unsaved changes',
          body: h('p', null, 'You have unsaved changes to ' + D.formatLongDate(st.date) + '.'),
          actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard', kind: 'danger', value: 'discard' }, { label: 'Save', kind: 'primary', value: 'save' }],
          dismissValue: 'cancel'
        }).then(function (c) {
          if (c === 'save') return flush();
          if (c === 'discard') { st.dirty = false; return true; }
          return false;
        });
      });
    }

    // ---------- opening a date ----------
    function open(date) {
      if (date === st.date) return Promise.resolve(true);
      var seq = ++openSeq;
      return ensureSafeToLeave().then(function (ok) {
        if (!ok || seq !== openSeq) return false;
        return ST.rpc('getEntry', date).then(function (entry) {
          if (seq !== openSeq) return false;
          load(entry);
          render();
          return true;
        }, function (err) {
          ST.toast('Could not open ' + date + ': ' + err.message, 'error');
          return false;
        });
      });
    }

    function load(entry) {
      st = emptyState();
      st.date = entry.date;
      st.points = entry.points.map(function (p) { return { key: newKey(), text: p.text, done: !!p.done }; });
      st.review = entry.review;
      st.durationMin = entry.durationMin === null ? '' : String(entry.durationMin);
      st.status = entry.status;
      st.tags = entry.tags.join(', ');
      st.rating = entry.rating;
    }

    /** Re-reads the open date from the database (used after a restore). Never discards unsaved edits. */
    function reload() {
      if (!st.date) return Promise.resolve(true);
      return ensureSafeToLeave().then(function (ok) {
        if (!ok) return false;
        var date = st.date;
        return ST.rpc('getEntry', date).then(function (entry) {
          if (st.date !== date) return false;
          load(entry);
          render();
          return true;
        }, function (err) { ST.toast('Could not refresh ' + date + ': ' + err.message, 'error'); return false; });
      });
    }

    function close() {
      return ensureSafeToLeave().then(function (ok) {
        if (!ok) return false;
        openSeq++;
        st = emptyState();
        render();
        return true;
      });
    }

    // ---------- learning points ----------
    function indexOfKey(key) { for (var i = 0; i < st.points.length; i++) if (st.points[i].key === key) return i; return -1; }

    function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, 34) + 'px'; }
    function autosizeAll() { root.querySelectorAll('.point-text').forEach(autosize); }

    function focusPoint(key) {
      var ta = refs.list && refs.list.querySelector('[data-key="' + key + '"] .point-text');
      if (ta) { ta.focus(); var n = ta.value.length; try { ta.setSelectionRange(n, n); } catch (e) { /* ignore */ } }
    }

    function addPoint(afterIndex, text) {
      var p = { key: newKey(), text: text || '', done: false };
      if (afterIndex === undefined || afterIndex >= st.points.length - 1) st.points.push(p);
      else st.points.splice(afterIndex + 1, 0, p);
      renderPoints();
      focusPoint(p.key);
      return p;
    }

    function movePoint(from, to, focusSelector) {
      if (to < 0 || to >= st.points.length || from === to) return;
      var p = st.points.splice(from, 1)[0];
      st.points.splice(to, 0, p);
      markDirty();
      renderPoints();
      if (focusSelector) {
        var btn = refs.list.querySelector('[data-key="' + p.key + '"] ' + focusSelector);
        if (btn && !btn.disabled) btn.focus();
        else { var other = refs.list.querySelector('[data-key="' + p.key + '"] .point-text'); if (other) other.focus(); }
      }
    }

    function deletePoint(index) {
      var removed = st.points.splice(index, 1)[0];
      var hadText = removed.text.trim() !== '';
      if (hadText) markDirty();
      renderPoints();
      var next = st.points[Math.min(index, st.points.length - 1)];
      if (next) focusPoint(next.key); else if (refs.add) refs.add.focus();
      if (hadText) {
        lastDeleted = { date: st.date, index: index, point: removed };
        ST.toast('Learning point deleted.', 'ok', 7000, { label: 'Undo', onClick: undoDelete });
      }
    }
    function undoDelete() {
      var d = lastDeleted;
      if (!d || d.date !== st.date) return;
      lastDeleted = null;
      st.points.splice(Math.min(d.index, st.points.length), 0, d.point);
      markDirty();
      renderPoints();
    }

    function pointRow(p, i) {
      var style = settings().listStyle;
      var n = st.points.length;
      var mark;
      if (style === 'checklist') {
        mark = h('input', { type: 'checkbox', checked: p.done, 'aria-label': 'Mark point ' + (i + 1) + ' as done', onchange: function (e) { p.done = e.target.checked; li.classList.toggle('done', p.done); markDirty(); } });
      } else mark = document.createTextNode(style === 'bullets' ? '•' : (i + 1) + '.');

      var ta = h('textarea', {
        class: 'point-text ed-text', rows: '1', value: p.text, placeholder: 'What did you learn?', spellcheck: 'false',
        'aria-label': 'Learning point ' + (i + 1),
        oninput: function () { p.text = ta.value; autosize(ta); markDirty(); },
        onkeydown: function (e) {
          var idx = indexOfKey(p.key);
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addPoint(idx); }
          else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); movePoint(idx, idx - 1, '.point-text'); }
          else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); movePoint(idx, idx + 1, '.point-text'); }
          else if (e.key === 'Backspace' && ta.value === '' && st.points.length > 1) { e.preventDefault(); deletePoint(idx); }
        }
      });

      var handle = h('button', {
        type: 'button', class: 'drag', draggable: 'true', title: 'Drag to reorder', 'aria-label': 'Drag to reorder point ' + (i + 1),
        ondragstart: function (e) {
          drag = { key: p.key };
          li.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', p.key); e.dataTransfer.setDragImage(li, 12, 12); } catch (err) { /* ignore */ }
        },
        ondragend: function () { endDrag(); }
      }, ST.svg(ST.ICON.grip, 16, { 'stroke-width': '3' }));

      var actions = h('div', { class: 'point-actions' },
        h('button', { type: 'button', class: 'mini mv-up', title: 'Move up (Alt+↑)', 'aria-label': 'Move point ' + (i + 1) + ' up', disabled: i === 0, onclick: function () { var idx = indexOfKey(p.key); movePoint(idx, idx - 1, '.mv-up'); } }, ST.svg(ST.ICON.up, 16)),
        h('button', { type: 'button', class: 'mini mv-down', title: 'Move down (Alt+↓)', 'aria-label': 'Move point ' + (i + 1) + ' down', disabled: i === n - 1, onclick: function () { var idx = indexOfKey(p.key); movePoint(idx, idx + 1, '.mv-down'); } }, ST.svg(ST.ICON.down, 16)),
        h('button', { type: 'button', class: 'mini del', title: 'Delete this point', 'aria-label': 'Delete point ' + (i + 1), onclick: function () { deletePoint(indexOfKey(p.key)); } }, ST.svg(ST.ICON.trash, 16)));

      var li = h('li', {
        class: 'point' + (style === 'checklist' && p.done ? ' done' : ''), dataset: { key: p.key },
        ondragover: function (e) {
          if (!drag || drag.key === p.key) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          var r = li.getBoundingClientRect();
          var before = e.clientY < r.top + r.height / 2;
          li.classList.toggle('drop-before', before);
          li.classList.toggle('drop-after', !before);
        },
        ondragleave: function () { li.classList.remove('drop-before', 'drop-after'); },
        ondrop: function (e) {
          if (!drag) return;
          e.preventDefault();
          var from = indexOfKey(drag.key), target = indexOfKey(p.key);
          var r = li.getBoundingClientRect();
          var before = e.clientY < r.top + r.height / 2;
          var to = before ? target : target + 1;
          if (from < to) to -= 1; // account for the removal of the dragged item
          endDrag();
          movePoint(from, to);
        }
      }, handle, h('span', { class: 'point-mark' }, mark), ta, actions);
      return li;
    }

    function endDrag() {
      drag = null;
      root.querySelectorAll('.dragging, .drop-before, .drop-after').forEach(function (el) { el.classList.remove('dragging', 'drop-before', 'drop-after'); });
    }

    function renderPoints() {
      if (!refs.list) return;
      refs.list.textContent = '';
      st.points.forEach(function (p, i) { refs.list.appendChild(pointRow(p, i)); });
      refs.empty.hidden = st.points.length > 0;
      refs.count.textContent = st.points.length ? String(st.points.length) : '';
      autosizeAll();
    }

    // ---------- metadata ----------
    function metaSummaryText() {
      var bits = [];
      if (st.durationMin !== '' && Number(st.durationMin) > 0) bits.push(D.formatMinutes(Number(st.durationMin)));
      if (st.rating) bits.push('★ ' + st.rating + '/5');
      var tags = splitTags(st.tags);
      if (tags.length) bits.push(tags.join(', '));
      return bits.join(' · ') || 'optional';
    }
    function updateMetaSummary() { if (refs.metaSum) refs.metaSum.textContent = metaSummaryText(); }

    function starButtons() {
      var wrap = h('div', { class: 'stars', role: 'group', 'aria-label': 'Daily rating' });
      function paint() {
        wrap.querySelectorAll('.star').forEach(function (b, idx) {
          var on = st.rating !== null && idx < st.rating;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', st.rating === idx + 1 ? 'true' : 'false');
        });
      }
      for (var i = 1; i <= 5; i++) {
        (function (value) {
          wrap.appendChild(h('button', {
            type: 'button', class: 'star', dataset: { value: String(value) }, 'aria-label': 'Rate ' + value + ' out of 5', title: value + ' / 5',
            onclick: function () { st.rating = st.rating === value ? null : value; paint(); markDirty(); }
          }, '★'));
        })(i);
      }
      wrap.appendChild(h('button', { type: 'button', class: 'btn ghost small', onclick: function () { if (st.rating !== null) { st.rating = null; paint(); markDirty(); } } }, 'Clear'));
      paint();
      return wrap;
    }

    // ---------- render ----------
    function render() {
      root.textContent = '';
      refs = {};
      root.classList.toggle('closed', !st.date);
      if (!st.date) {
        root.appendChild(h('div', { class: 'ed-empty' },
          h('p', null, 'Select a date to open its study journal.'),
          h('p', { class: 'hint' }, 'Every date has its own learning log and personal review. Nothing is created until you write something.')));
        return;
      }

      var isToday = st.date === deps.todayISO();
      refs.status = h('select', { 'aria-label': 'Daily status', onchange: function (e) { st.status = e.target.value; markDirty(); } },
        M.STATUSES.map(function (s) { return h('option', { value: s, selected: s === st.status }, M.STATUS_LABELS[s]); }));
      refs.saveText = h('span', null, '');
      refs.save = h('span', { class: 'save-status', role: 'status', 'aria-live': 'polite', id: 'save-status' }, h('span', { class: 'save-dot' }), refs.saveText);

      var head = h('div', { class: 'ed-head' },
        h('div', { class: 'ed-title-row' },
          h('h2', { class: 'ed-title', id: 'ed-title' }, D.formatLongDate(st.date), isToday ? h('small', null, 'Today') : null),
          h('button', { type: 'button', class: 'icon-btn', id: 'ed-close', 'aria-label': 'Close journal', title: 'Close journal', onclick: function () { deps.onClose(); } }, ST.svg(ST.ICON.close, 18))),
        h('div', { class: 'ed-controls' }, refs.status, refs.save));
      refs.status.id = 'ed-status';

      refs.list = h('ul', { class: 'points', 'aria-labelledby': 'log-h' });
      refs.empty = h('p', { class: 'log-empty' }, 'Nothing logged for this day yet.');
      refs.count = h('span', { class: 'count' }, '');
      refs.add = h('button', { type: 'button', class: 'btn add-point', id: 'add-point', onclick: function () { addPoint(); } }, ST.svg(ST.ICON.plus, 16), 'Add learning point');

      var review = h('textarea', {
        class: 'review-text ed-text', id: 'review', value: st.review, spellcheck: 'false',
        placeholder: 'What did you understand well? What was difficult? What needs revision? What will you learn next?',
        'aria-labelledby': 'review-h',
        oninput: function (e) { st.review = e.target.value; markDirty(); }
      });

      var hasMeta = st.durationMin !== '' || st.rating !== null || st.tags !== '';
      refs.metaSum = h('span', { class: 'meta-sum' }, metaSummaryText());
      var meta = h('details', { class: 'meta', open: hasMeta || metaOpenPref, ontoggle: function (e) { metaOpenPref = e.target.open; } },
        h('summary', null, 'Details', refs.metaSum),
        h('div', { class: 'meta-body' },
          h('div', { class: 'meta-grid' },
            h('div', { class: 'field' }, h('label', { for: 'duration' }, 'Study time (minutes)'),
              h('input', { type: 'number', id: 'duration', min: '0', max: String(M.LIMITS.maxMinutes), step: '5', inputmode: 'numeric', value: st.durationMin, placeholder: 'e.g. 90', oninput: function (e) { st.durationMin = e.target.value; markDirty(); } })),
            h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Rating'), starButtons())),
          h('div', { class: 'field' }, h('label', { for: 'tags' }, 'Tags / topics (comma separated)'),
            h('input', { type: 'text', id: 'tags', value: st.tags, placeholder: 'e.g. cpp, dsa, গণিত', oninput: function (e) { st.tags = e.target.value; markDirty(); } }))));

      var scroll = h('div', { class: 'ed-scroll' },
        h('section', { class: 'ed-sec', 'aria-labelledby': 'log-h' },
          h('h3', { id: 'log-h' }, 'Learning log', refs.count), refs.empty, refs.list, refs.add),
        h('section', { class: 'ed-sec' }, h('h3', { id: 'review-h' }, 'Personal review'), review),
        meta);

      var foot = h('div', { class: 'ed-foot' },
        h('span', null, h('span', { class: 'kbd' }, 'Ctrl'), '+', h('span', { class: 'kbd' }, 'Enter'), ' new point'),
        h('span', null, h('span', { class: 'kbd' }, 'Alt'), '+', h('span', { class: 'kbd' }, '↑↓'), ' move'),
        h('span', null, h('span', { class: 'kbd' }, 'Ctrl'), '+', h('span', { class: 'kbd' }, 'S'), ' save'));

      root.appendChild(head); root.appendChild(scroll); root.appendChild(foot);
      setState(st.dirty ? 'unsaved' : 'saved');
      renderPoints();
    }

    window.addEventListener('resize', ST.debounce(autosizeAll, 120));

    render();

    return {
      open: open,
      close: close,
      reload: reload,
      flush: flush,
      saveNow: function () { return flush(); },
      ensureSafeToLeave: ensureSafeToLeave,
      currentDate: function () { return st.date; },
      isDirty: function () { return st.dirty; },
      applySettings: function () {
        if (!st.date) return;
        renderPoints();
        setState(st.state, st.stateMsg);
        if (st.dirty && settings().autosave) schedule();
      },
      focusLog: function () { if (refs.add) addPoint(); },
      refreshToday: function () { /* title shows "Today" only at render time; fine for a session */ }
    };
  }

  ST.createEditor = createEditor;
})();
