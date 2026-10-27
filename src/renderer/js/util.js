/* Study Tracker — small DOM/utility helpers, toasts, modals, fonts. Everything is built with
   textContent / createElement (never innerHTML), so user text can never inject markup. */
(function () {
  'use strict';

  var ST = (window.ST = window.ST || {});

  /** h('div', {class:'x', onclick: fn, dataset:{a:1}}, 'text', childNode, [more, children]) */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden' || k === 'open') { if (v) el[k] = true; }
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
  }

  function svg(pathData, size, extra) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 16));
    s.setAttribute('height', String(size || 16));
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', pathData);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    if (extra) Object.keys(extra).forEach(function (k) { p.setAttribute(k, extra[k]); });
    s.appendChild(p);
    return s;
  }
  var ICON = {
    check: 'M5 12.5l4.2 4.2L19 7',
    note: 'M5 20h4l10-10-4-4L5 16v4zM13.5 7.5l4 4',
    up: 'M6 14l6-6 6 6',
    down: 'M6 10l6 6 6-6',
    trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5',
    grip: 'M9 6v.01M15 6v.01M9 12v.01M15 12v.01M9 18v.01M15 18v.01',
    plus: 'M12 5v14M5 12h14',
    close: 'M6 6l12 12M18 6L6 18'
  };

  function debounce(fn, ms) {
    var t = null;
    function wrapped() {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    }
    wrapped.cancel = function () { clearTimeout(t); t = null; };
    wrapped.pending = function () { return t !== null; };
    return wrapped;
  }

  // ---- RPC wrapper: the main process answers {ok, data} | {ok:false, message} ----
  function rpc(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return window.api.rpc(method, args).then(function (r) {
      if (!r || !r.ok) { var e = new Error((r && r.message) || 'The action could not be completed.'); e.userMessage = e.message; throw e; }
      return r.data;
    });
  }

  // ---- toasts ----
  function toast(message, kind, ms, action) {
    var root = document.getElementById('toasts');
    var el = h('div', { class: 'toast ' + (kind || 'ok'), role: kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 't-icon' }, svg(kind === 'error' ? 'M12 8v5M12 16.5v.01M10.3 3.9L2.5 18a2 2 0 001.7 3h15.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z' : ICON.check, 18)),
      h('span', { class: 't-msg' }, message),
      action ? h('button', { type: 'button', class: 'btn small', onclick: function () { el.remove(); action.onClick(); } }, action.label) : null,
      h('button', { type: 'button', 'aria-label': 'Dismiss', onclick: function () { el.remove(); } }, '×'));
    root.appendChild(el);
    var life = ms || (kind === 'error' ? 9000 : 3800);
    setTimeout(function () { if (el.parentNode) el.remove(); }, life);
    while (root.children.length > 4) root.firstChild.remove();
    return el;
  }

  // ---- modal ----
  var activeModal = null;
  /**
   * openModal({title, body: Node|Node[], actions:[{label, kind, value}], dismissValue})
   * Resolves with the chosen action's value (or dismissValue on Esc / backdrop click).
   */
  function openModal(opts) {
    return new Promise(function (resolve) {
      var root = document.getElementById('modal-root');
      var previouslyFocused = document.activeElement;
      var settled = false;
      function close(value) {
        if (settled) return;
        settled = true;
        back.remove();
        activeModal = null;
        if (previouslyFocused && previouslyFocused.focus) { try { previouslyFocused.focus(); } catch (e) { /* ignore */ } }
        resolve(value);
      }
      var buttons = (opts.actions || []).map(function (a) {
        return h('button', { type: 'button', class: 'btn' + (a.kind ? ' ' + a.kind : ''), dataset: { value: String(a.value) }, disabled: a.disabled, onclick: function () { close(a.value); } }, a.label);
      });
      var titleId = 'modal-title-' + Date.now();
      var modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('h2', { id: titleId }, opts.title), opts.body, h('div', { class: 'actions' }, buttons));
      var back = h('div', { class: 'modal-back', onmousedown: function (e) { if (e.target === back && opts.dismissValue !== undefined) close(opts.dismissValue); } }, modal);
      back.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && opts.dismissValue !== undefined) { e.stopPropagation(); close(opts.dismissValue); }
        if (e.key === 'Tab') { // keep focus inside the dialog
          var f = modal.querySelectorAll('button:not(:disabled), input, select, textarea, [href]');
          if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      });
      activeModal = { close: close, update: function () { /* hook for dynamic bodies */ }, modal: modal };
      root.appendChild(back);
      var primary = buttons.filter(function (b) { return b.classList.contains('primary') && !b.disabled; })[0] || buttons[buttons.length - 1];
      if (primary) primary.focus();
    });
  }
  function isModalOpen() { return !!activeModal; }

  function alertModal(title, message, list) {
    var body = [h('p', null, message)];
    if (list && list.length) body.push(h('ul', { class: 'errs' }, list.map(function (m) { return h('li', null, m); })));
    return openModal({ title: title, body: body, actions: [{ label: 'OK', kind: 'primary', value: true }], dismissValue: true });
  }

  // ---- fonts: only fonts that are really installed on this computer are offered ----
  var BANGLA_FALLBACK = '"Nirmala UI", "Vrinda", "Shonar Bangla", "Noto Sans Bengali", "Kohinoor Bangla", "Bangla Sangam MN", ';
  var FONT_CANDIDATES = [
    { name: 'Segoe UI' }, { name: 'Calibri' }, { name: 'Arial' }, { name: 'Verdana' }, { name: 'Tahoma' },
    { name: 'Trebuchet MS' }, { name: 'Georgia' }, { name: 'Cambria' }, { name: 'Times New Roman' },
    { name: 'Constantia' }, { name: 'Palatino Linotype' }, { name: 'Consolas' }, { name: 'Cascadia Mono' }, { name: 'Courier New' },
    { name: 'Nirmala UI' }, { name: 'Vrinda' }, { name: 'Shonar Bangla' }, { name: 'Noto Sans Bengali' }, { name: 'Noto Sans' },
    { name: 'Roboto' }, { name: 'Helvetica' }, { name: 'DejaVu Sans' }, { name: 'Liberation Sans' }, { name: 'Ubuntu' }, { name: 'SF Pro Text' }
  ];

  function fontStack(name) {
    var generic = 'system-ui, "Segoe UI", "Noto Sans Bengali", sans-serif';
    if (!name || name === 'system') return 'system-ui, "Segoe UI", ' + BANGLA_FALLBACK + 'sans-serif';
    var safe = String(name).replace(/["\\]/g, '');
    return '"' + safe + '", ' + BANGLA_FALLBACK + generic;
  }

  var measureCanvas = null;
  function isFontInstalled(name) {
    try {
      if (!measureCanvas) measureCanvas = document.createElement('canvas').getContext('2d');
      var sample = 'mmmmmmmmmmlli0Oq বাংলা';
      var bases = ['monospace', 'serif', 'sans-serif'];
      for (var i = 0; i < bases.length; i++) {
        measureCanvas.font = '72px ' + bases[i];
        var baseW = measureCanvas.measureText(sample).width;
        measureCanvas.font = '72px "' + name + '", ' + bases[i];
        if (measureCanvas.measureText(sample).width !== baseW) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  var installedCache = null;
  function installedFonts() {
    if (!installedCache) installedCache = FONT_CANDIDATES.filter(function (f) { return isFontInstalled(f.name); }).map(function (f) { return f.name; });
    return installedCache;
  }

  ST.h = h; ST.svg = svg; ST.ICON = ICON; ST.debounce = debounce; ST.rpc = rpc; ST.toast = toast;
  ST.openModal = openModal; ST.alertModal = alertModal; ST.isModalOpen = isModalOpen;
  ST.fontStack = fontStack; ST.installedFonts = installedFonts;
})();
