# DiskDive 🤿

A cross-platform (Electron) desktop app that analyzes disk usage for a folder you
choose, shows what's taking up space, and **suggests** removal candidates.

> **Analyze-only.** DiskDive never deletes, moves, or modifies any file. The only
> action it ever takes on a file is "Reveal" — opening its folder in Finder /
> Explorer. Anything you remove, you remove yourself, by hand, after reviewing it.

## What it does

- Scan a folder you pick (Downloads, Documents, a project dir, …).
- Summarize total size, file/folder counts, and reclaimable space.
- **Suggested for review** — a file is only suggested if it is **both**:
  - **at least 30 days old** (last modified), **and**
  - **not opened/read in at least 30 days** (last access time).

  Each suggestion also notes why it stands out — a build/cache folder
  (`node_modules`, `dist`, `build`, `.cache`, `__pycache__`, …), a disposable type
  (`.log`, `.tmp`, `.bak`, `.dmg`, …), or a large file (≥ 100 MB) — but the 30-day
  age **and** 30-day unused gate must pass first. Recently created or recently used
  files are never flagged.
- **Largest files** and **By file type** breakdowns.

## What it will not touch

Files needed for operation are **never** flagged, by design:

- keys & credentials — `.pem`, `.key`, `id_rsa`, `credentials`, `secrets`, `.env`, …
- config & app data — anything under `Library/`, `.ssh/`, `.config/`, `.aws/`, `.git/`, …
- source manifests — `package.json`, lockfiles, `Cargo.toml`, `go.mod`, `pyproject.toml`, …

System directories (`/System`, `/Library`, `/usr`, `Program Files`, `C:\Windows`, …)
**can't be scanned at all** — DiskDive refuses them.

Symlinks are never followed, so a scan stays inside the folder you chose.

## Run it

```bash
npm install
npm start
```

Requires Node.js and npm. `npm install` pulls in Electron (~download on first run).

## How removal works

DiskDive points; it never acts. For each candidate you can click **Reveal** to open
it in your file manager and decide for yourself. There is deliberately no "delete"
button — moving a file to the Trash is something you do, where you can see it.
