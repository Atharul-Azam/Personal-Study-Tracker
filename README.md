# Study Tracker

An offline desktop study journal for Windows 10/11. Every calendar date is its own journal: a **learning log**, a **personal review**, and optional **study time / status / tags / rating**. No account, no cloud, no ads, no telemetry — everything stays in a local SQLite file on your computer.

## Features

- Interactive monthly calendar, opens on the current month; Previous / Next / **Today**, and a month + year picker.
- **No ghost dates**: only the days of the selected month are drawn; blank cells keep weekday alignment and contain nothing.
- Two views — **Grid** and **List** (one card per date: date, weekday, summary, status). Same data in both; your choice is remembered.
- Daily journal (right-hand panel): add / edit / delete / reorder learning points (drag-and-drop, ↑↓ buttons, `Alt+↑/↓`), multi-line text, plain-text links, numbered / bullet / checklist styles; free-form personal review; optional duration, status (Not started / In progress / Completed), tags and 1–5 rating.
- **Autosave** (≈0.7 s debounce) with a *Saved / Saving… / Unsaved changes / Not saved* indicator. Switching dates or months, exporting, or closing the window saves first; with autosave off you are asked before anything unsaved could be lost.
- Settings sidebar: theme (Light / Dark / System), interface and editor fonts + sizes (only fonts installed on your PC are listed; Bangla and other Unicode text always has a fallback), default view, first day of week (Sat / Sun / Mon), autosave, storage location, backup & restore.
- Monthly summary: study days, completed days, learning points, total time, days with a review.
- Backup: JSON export/import (validated, all-or-nothing), full local database backup, CSV summary export.

### What counts as a "study day" / "completed"

- **Completed** only when *you* set the day's status to Completed. Opening a date never marks anything, and never creates a record.
- **Study day** = the date has at least one learning point, *or* status In progress / Completed, *or* a study time above zero. A date with only a personal review is shown with a note indicator but is not counted as a study day.
- A date with nothing in it is not stored at all.

## Technology (and why)

**Electron + the SQLite engine built into Node (`node:sqlite`) + plain HTML/CSS/JS** (no UI framework, no bundler).

- Windows packaging is mature (`electron-builder`: installer with Start Menu shortcut, plus a portable `.exe`), and the bundled Chromium gives reliable rendering of Bangla and other complex scripts, system fonts and light/dark theming.
- `node:sqlite` means no native module to compile — nothing extra to ship, nothing that can fail to build on a user's PC.
- Zero runtime dependencies: the app ships only Electron and its own ~3k lines of code.
- Trade-off: an Electron app is larger on disk (~80–100 MB installed) than a native one. Startup and memory are reasonable because there is no framework, no server, no background process, and only the current month is loaded.

## Project layout

```
src/
  main/        Electron main process (Node)
    main.js      window, per-user data folder, native dialogs, offline hardening, --smoke-test
    preload.js   the small, fixed API exposed to the UI (sandboxed, no Node in the UI)
    service.js   the application API (Electron-free, shared by IPC and tests)
    store.js     data access (transactions, month summaries, statistics, restore)
    db.js        SQLite open + integrity check + versioned migrations
    backup.js    JSON export / strict import validation / CSV export
  shared/      Pure logic used by both sides
    dates.js     calendar math (leap years, weekday alignment, month grid/list)
    model.js     entry + settings validation, "study day" rule
  renderer/    The UI (index.html, css/app.css, js/*.js)
  assets/      icon
test/
  unit/        dates, store, backup/restore, main-process (against a fake Electron)
  ui/          end-to-end tests: the real UI + real SQLite in headless Chromium
scripts/       build-windows.ps1, make-icon.py
.github/workflows/build-windows.yml   builds + smoke-tests the .exe on Windows
```

## Run from source

Requirements: **Node.js 22.13+** (https://nodejs.org). Internet is only needed once, to download dependencies.

```
npm install
npm start
```

## Tests

```
npm test            # unit tests (dates, storage, backup/restore, main process) – no browser needed
npx playwright install chromium   # once
npm run test:ui     # end-to-end UI tests in headless Chromium
npm run smoke       # launches the REAL Electron app headlessly and checks it (see below)
```

`npm run smoke` / `Study Tracker.exe --smoke-test --smoke-out=result.json` starts the app with a throw-away data folder and checks: the window opens, the calendar shows exactly the current month's days with no adjacent-month dates, a journal entry can be saved, **all network requests are blocked**, the entry survives a reload, and the data is really in the SQLite file on disk. It writes a JSON report and exits 0 only if every check passes.

## Build the Windows app

On a Windows PC with Node.js 22.13+:

```
build-windows.bat
```

or

```
npm install
npm run dist:win
```

Output in `dist\`:

| File | What |
|---|---|
| `StudyTracker-<version>-setup.exe` | Installer (per-user, choose folder, Start Menu + Desktop shortcut) |
| `StudyTracker-<version>-portable.exe` | Single-file portable version (no install) |
| `win-unpacked\Study Tracker.exe` | Unpacked app (used for the smoke test) |

`scripts\build-windows.ps1` (what `build-windows.bat` runs) installs, runs the unit tests, builds, then smoke-tests the packaged exe and fails loudly if it doesn't work. The GitHub Actions workflow does the same on `windows-latest`, additionally runs the UI tests, silently installs the setup `.exe`, checks the Start Menu shortcut, and smoke-tests the *installed* app.

The built app needs no Node.js, Python or internet connection.

## Where your data lives

| What | Where (Windows) |
|---|---|
| Journal + settings database | `%APPDATA%\Study Tracker\study-tracker.db` (plus `-wal`/`-shm` while running) |
| Local backups & automatic safety backups | `%APPDATA%\Study Tracker\backups\` |

This folder is outside the install directory, so your data survives restarts, updates, re-installs and un-installs (the uninstaller does not delete it). The exact path is shown in **Settings → Data & backup**, with an *Open data folder* button.

Database schema is versioned (`PRAGMA user_version`); before any future migration the old file is copied next to it (`*.before-vN.bak`). A database from a *newer* app version is refused untouched; a damaged database file is reported and never deleted.

## Backup & restore

Settings (☰) → **Data & backup**:

- **Export all records (JSON)** – every day plus your settings, human-readable.
- **Import / restore (JSON)** – the file is fully validated first; one bad entry rejects the whole file and nothing is changed. Then you choose:
  - *Add only days that don't exist yet* (default; your current days are untouched),
  - *Overwrite days that are in the backup* (other days untouched),
  - *Replace everything* (asks twice).
  Overwrite and Replace first write an automatic safety backup of your current data to `backups\`. Restoring settings (theme, fonts…) is a separate, unticked-by-default checkbox.
- **Create full local backup** – a consistent copy of the whole database (`backups\study-tracker-backup-<date>.db`). To restore one, close the app and copy it over `study-tracker.db`.
- **Export summary (CSV)** – one row per date (UTF-8 with BOM, opens correctly in Excel, Bangla included).

## Keyboard shortcuts

`Ctrl+S` save now · `Ctrl+Enter` new learning point · `Alt+↑/↓` move point · `PageUp/PageDown` previous/next month · `T` today · `Ctrl+,` settings panel · `Esc` closes pickers/dialogs.

## Privacy and offline guarantees

No accounts, no sync, no analytics, no telemetry, no update pings, no remote fonts or scripts. Beyond not writing any networking code, the app **enforces** this: a strict Content-Security-Policy (`default-src 'none'`, no external hosts) and a main-process filter that cancels every `http`, `https`, `ws`, `wss` and `ftp` request. The UI runs sandboxed with context isolation and no Node access.

## Limits and known gaps

- Dates are limited to years 1900–2200. A day holds up to 500 learning points (20,000 characters each) and a 200,000-character review.
- Windows is the target. The code is cross-platform in principle, but only Windows packaging is configured.
- No automatic updater (by design: no network). Install a newer setup `.exe` over the old one; data is kept.
- The installer is unsigned, so Windows SmartScreen may warn on first run ("More info → Run anyway"). Code signing needs a certificate that only you can obtain.
