'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

// ---------------------------------------------------------------------------
// Safety model
// ---------------------------------------------------------------------------
// DiskDive is an ANALYZE-ONLY tool. It never deletes, moves, or modifies any
// file. The most it will ever do to a file is open its folder in the system
// file manager ("Reveal"). The constants below are used to make sure we never
// even *suggest* removing something the OS or installed apps need to run.

const HOME = os.homedir();

// Roots we refuse to scan at all — scanning these is pointless (they're
// system-owned) and we never want to imply any of their contents is junk.
const PROTECTED_ROOTS = [
  '/System', '/Library', '/bin', '/sbin', '/usr', '/private', '/Applications',
  '/Volumes', '/cores', '/opt', '/etc', '/var',
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
].map((p) => p.toLowerCase());

// Path fragments that mark a file as operationally important. If any of these
// appear in a file's path we will NEVER label it a removal candidate, no
// matter its size or age.
const PROTECTED_FRAGMENTS = [
  // macOS / user config that apps depend on
  '/library/', '/.ssh/', '/.gnupg/', '/.config/', '/.aws/', '/.kube/',
  '/.docker/', '/keychains/', '/.git/', '/.gitconfig',
  // credentials / keys / environment
  '.pem', '.key', '.crt', '.p12', '.keychain', 'id_rsa', 'id_ed25519',
  'credentials', 'secrets', '.env',
  // source and project manifests (not build output)
  'package.json', 'yarn.lock', 'pnpm-lock', 'cargo.toml', 'go.mod',
  'requirements.txt', 'pyproject.toml', 'gemfile', 'pom.xml',
];

// Directory names whose contents are regenerable — safe to SUGGEST (not act on).
const CANDIDATE_DIRS = new Set([
  'node_modules', '.cache', 'cache', 'caches', '.gradle', '.m2',
  'deriveddata', '.next', '.nuxt', 'dist', 'build', 'target', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.parcel-cache', '.turbo', 'tmp', 'temp',
]);

// File extensions that are typically disposable.
const CANDIDATE_EXTS = new Set([
  '.log', '.tmp', '.temp', '.cache', '.bak', '.old', '.crdownload',
  '.part', '.dmp', '.dmg', '.iso',
]);

const LARGE_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const MIN_AGE_DAYS = 30;    // must be at least this old (last modified)
const UNUSED_DAYS = 30;     // AND not opened/read in at least this long (last access)
const MAX_ENTRIES = 400000; // guard against pathological trees

function isProtectedRoot(target) {
  const t = target.toLowerCase();
  return PROTECTED_ROOTS.some((r) => t === r || t.startsWith(r + path.sep) || t.startsWith(r + '/'));
}

function isProtectedPath(p) {
  const lower = p.toLowerCase();
  return PROTECTED_FRAGMENTS.some((frag) => lower.includes(frag));
}

function classify(filePath, size, mtimeMs, atimeMs) {
  // Never flag anything operationally important.
  if (isProtectedPath(filePath)) return null;

  const ageDays = (Date.now() - mtimeMs) / 86400000;   // since last modified
  const unusedDays = (Date.now() - atimeMs) / 86400000; // since last opened/read

  // Hard gate: a file is only ever a deletion candidate if it is BOTH at least
  // 30 days old AND has not been accessed in at least 30 days. Recently created
  // or recently used files are never suggested, whatever their size or type.
  if (ageDays < MIN_AGE_DAYS || unusedDays < UNUSED_DAYS) return null;

  const ext = path.extname(filePath).toLowerCase();
  const segments = filePath.toLowerCase().split(/[\\/]/);

  const reasons = [
    `${Math.floor(ageDays)} days old`,
    `not opened in ${Math.floor(unusedDays)} days`,
  ];
  if (segments.some((s) => CANDIDATE_DIRS.has(s))) reasons.push('regenerable (build/cache folder)');
  if (CANDIDATE_EXTS.has(ext)) reasons.push('disposable file type');
  if (size >= LARGE_FILE_BYTES) reasons.push('large file (≥100 MB)');

  return reasons;
}

// Recursively walk a directory, collecting stats. Never follows symlinks.
async function walk(root, onProgress) {
  const result = {
    root,
    totalBytes: 0,
    fileCount: 0,
    dirCount: 0,
    largest: [],          // top N by size
    candidates: [],       // suggested-for-review
    byExtension: {},      // ext -> { bytes, count }
    truncated: false,
    skipped: [],          // paths we couldn't read
  };

  const stack = [root];
  let processed = 0;

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      result.skipped.push({ path: dir, reason: err.code || 'unreadable' });
      continue;
    }

    for (const entry of entries) {
      if (result.fileCount + result.dirCount >= MAX_ENTRIES) {
        result.truncated = true;
        stack.length = 0;
        break;
      }
      const full = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) continue; // never traverse or stat links

      if (entry.isDirectory()) {
        result.dirCount++;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      let stat;
      try {
        stat = await fsp.stat(full);
      } catch (err) {
        result.skipped.push({ path: full, reason: err.code || 'unreadable' });
        continue;
      }

      const size = stat.size;
      result.fileCount++;
      result.totalBytes += size;

      const ext = (path.extname(entry.name) || '(none)').toLowerCase();
      const bucket = result.byExtension[ext] || (result.byExtension[ext] = { bytes: 0, count: 0 });
      bucket.bytes += size;
      bucket.count++;

      // Track largest files (keep a small sorted list).
      insertTop(result.largest, { path: full, size }, 50);

      const reasons = classify(full, size, stat.mtimeMs, stat.atimeMs);
      if (reasons) {
        insertTop(
          result.candidates,
          { path: full, size, reasons, mtimeMs: stat.mtimeMs, atimeMs: stat.atimeMs },
          300,
          (x) => x.size
        );
      }

      processed++;
      if (processed % 2000 === 0 && onProgress) {
        onProgress({ files: result.fileCount, bytes: result.totalBytes });
      }
    }
  }

  result.candidateBytes = result.candidates.reduce((a, c) => a + c.size, 0);
  // Collapse byExtension into a sorted top list for display.
  result.extensions = Object.entries(result.byExtension)
    .map(([ext, v]) => ({ ext, ...v }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20);
  delete result.byExtension;
  return result;
}

function insertTop(arr, item, limit, key = (x) => x.size) {
  // keep arr sorted descending by key, capped at `limit`
  if (arr.length < limit || key(item) > key(arr[arr.length - 1])) {
    arr.push(item);
    arr.sort((a, b) => key(b) - key(a));
    if (arr.length > limit) arr.pop();
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0f1115',
    title: 'DiskDive',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC — all read-only
// ---------------------------------------------------------------------------
ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a folder to analyze',
    defaultPath: path.join(HOME, 'Downloads'),
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('scan', async (_evt, target) => {
  if (typeof target !== 'string' || !target) {
    return { error: 'No folder selected.' };
  }
  const resolved = path.resolve(target);

  if (isProtectedRoot(resolved)) {
    return {
      error:
        'That location is a system directory. DiskDive won\u2019t scan system areas — ' +
        'pick a personal folder like Downloads, Documents, or a project directory.',
    };
  }
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) return { error: 'That path is not a folder.' };
  } catch {
    return { error: 'That folder could not be opened.' };
  }

  const started = Date.now();
  const data = await walk(resolved, (p) => {
    if (win && !win.isDestroyed()) win.webContents.send('scan-progress', p);
  });
  data.elapsedMs = Date.now() - started;
  return data;
});

// Reveal a file in the OS file manager. This is the ONLY file-targeting action
// DiskDive performs — it opens a Finder/Explorer window; it never deletes.
ipcMain.handle('reveal', async (_evt, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return false;
  try {
    shell.showItemInFolder(path.resolve(filePath));
    return true;
  } catch {
    return false;
  }
});
