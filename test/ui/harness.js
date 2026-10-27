'use strict';
/*
 * UI test harness.
 *
 * Serves the REAL renderer files (src/renderer + src/shared) over localhost and routes the
 * app's `window.api` calls to the REAL service/SQLite store, exactly as Electron's IPC does.
 * Only the native file dialogs are simulated (export captures the text, import feeds a prepared file).
 *
 * Chromium is the same engine Electron uses, and it enforces the page's real Content-Security-Policy.
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../src/main/store.js');
const { createService } = require('../../src/main/service.js');

const ROOT = path.join(__dirname, '..', '..', 'src');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function mapUrl(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? '/index.html' : clean;
  const base = rel.startsWith('/shared/') ? path.join(ROOT, 'shared') : path.join(ROOT, 'renderer');
  const sub = rel.startsWith('/shared/') ? rel.slice('/shared/'.length) : rel.slice(1);
  const full = path.resolve(base, sub);
  return full.startsWith(base + path.sep) ? full : null;
}

// Injected before the app loads: defines window.api over HTTP, mirroring preload.js.
const SHIM = `
(() => {
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  window.api = {
    rpc: (method, args) => post('/__rpc', { method, args }),
    exportFile: (kind) => post('/__export', { kind }),
    pickImport: () => post('/__import'),
    openDataFolder: () => post('/__noop'),
    showFile: (file) => post('/__show', { file }),
    setNativeTheme: () => {},
    onCloseRequested: (cb) => { window.__closeRequested = cb; },
    respondToClose: (ok) => { window.__closeResponse = ok; }
  };
})();
`;

async function startHarness(options) {
  const opts = options || {};
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'study-tracker-ui-'));
  const dbFile = path.join(dir, 'study-tracker.db');
  const h = { dir, dbFile, lastExport: {}, nextImportText: null, shown: [], rpcLog: [], failNextSave: false, store: null, service: null };

  function open() {
    h.store = createStore(dbFile);
    h.service = createService(h.store, { dataDir: dir, appVersion: 'ui-test', log: () => {} });
  }
  open();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        let out;
        if (req.url === '/__rpc') {
          h.rpcLog.push(body.method);
          if (body.method === 'saveEntry' && h.failNextSave) {
            h.failNextSave = false;
            out = { ok: false, message: 'Simulated disk failure.' };
          } else out = await h.service.invoke(body.method, body.args);
        } else if (req.url === '/__export') {
          const r = await h.service.invoke(body.kind === 'csv' ? 'exportCsv' : 'exportJson', []);
          if (r.ok) { h.lastExport[body.kind] = r.data; out = { ok: true, path: path.join(dir, r.data.suggestedName) }; } else out = r;
        } else if (req.url === '/__import') {
          if (h.nextImportText === null) out = { ok: true, canceled: true };
          else {
            const text = h.nextImportText; h.nextImportText = null;
            const r = await h.service.invoke('analyzeBackup', [text]);
            out = r.ok ? { ok: true, analysis: r.data, fileName: 'test-backup.json' } : r;
          }
        } else if (req.url === '/__show') { h.shown.push(body.file); out = { ok: true }; }
        else out = { ok: true };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }
      const file = mapUrl(req.url);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'harness error: ' + err.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  h.url = 'http://127.0.0.1:' + server.address().port + '/index.html';
  h.origin = 'http://127.0.0.1:' + server.address().port;
  h.shim = SHIM;

  /** Simulates quitting and re-launching the app: closes the database and opens the same file again. */
  h.restartBackend = () => { h.store.close(); open(); };
  h.close = async () => { await new Promise((r) => server.close(r)); try { h.store.close(); } catch (_) { /* ignore */ } };
  return h;
}

/** Pretend "now" is a fixed local date/time (so "today" is deterministic). Timers keep running normally. */
function fixedClockScript(y, m, d, hh) {
  return `(() => {
    const fixed = new Date(${y}, ${m - 1}, ${d}, ${hh || 10}, 0, 0).getTime();
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
      static now() { return fixed; }
    }
    window.Date = FakeDate;
  })();`;
}

module.exports = { startHarness, fixedClockScript };
