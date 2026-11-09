'use strict';

const $ = (id) => document.getElementById(id);
let lastTarget = null;

function fmtBytes(n) {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtInt(n) {
  return n.toLocaleString();
}

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function row(filePath, size, extraHtml = '') {
  const el = document.createElement('div');
  el.className = 'item';
  const name = filePath.split(/[\\/]/).pop();
  const dir = filePath.slice(0, filePath.length - name.length);
  el.innerHTML = `
    <div class="item-main">
      <div class="item-name" title="${escapeHtml(filePath)}">${escapeHtml(name)}</div>
      <div class="item-dir">${escapeHtml(dir)}</div>
      ${extraHtml}
    </div>
    <div class="item-size">${fmtBytes(size)}</div>
    <button class="reveal" data-path="${escapeHtml(filePath)}">Reveal</button>
  `;
  return el;
}

async function runScan(target) {
  lastTarget = target;
  hide('intro'); hide('results'); hide('error');
  show('progress');
  $('scanTarget').textContent = target;
  $('progressText').textContent = 'Scanning…';
  $('rescanBtn').disabled = true;

  const data = await window.diskdive.scan(target);
  hide('progress');
  $('rescanBtn').disabled = false;

  if (!data || data.error) {
    $('error').textContent = (data && data.error) || 'Scan failed.';
    show('error');
    return;
  }
  render(data);
}

function render(data) {
  $('statTotal').textContent = fmtBytes(data.totalBytes);
  $('statFiles').textContent = fmtInt(data.fileCount);
  $('statDirs').textContent = fmtInt(data.dirCount);
  $('statCandidates').textContent = fmtBytes(data.candidateBytes);
  $('resultPath').textContent =
    `${data.root}  ·  scanned in ${(data.elapsedMs / 1000).toFixed(1)}s` +
    (data.truncated ? '  ·  (very large tree — results partial)' : '');

  // Candidates
  const cl = $('candidateList');
  cl.innerHTML = '';
  if (!data.candidates.length) {
    cl.innerHTML = '<p class="muted">Nothing obvious to suggest — this folder looks lean. 🎉</p>';
  } else {
    for (const c of data.candidates) {
      const dates =
        `<div class="dates">` +
        `<span>Last modified: <strong>${fmtDate(c.mtimeMs)}</strong></span>` +
        `<span>Last opened: <strong>${fmtDate(c.atimeMs)}</strong></span>` +
        `</div>`;
      const reasons = `<div class="reasons">${c.reasons
        .map((r) => `<span class="chip">${escapeHtml(r)}</span>`)
        .join('')}</div>`;
      cl.appendChild(row(c.path, c.size, dates + reasons));
    }
  }

  // Largest
  const ll = $('largestList');
  ll.innerHTML = '';
  if (!data.largest.length) {
    ll.innerHTML = '<p class="muted">No files found.</p>';
  } else {
    for (const f of data.largest) ll.appendChild(row(f.path, f.size));
  }

  // Types
  const tl = $('typesList');
  tl.innerHTML = '';
  for (const t of data.extensions) {
    const el = document.createElement('div');
    el.className = 'item type-row';
    el.innerHTML = `
      <div class="item-main">
        <div class="item-name">${escapeHtml(t.ext)}</div>
        <div class="item-dir">${fmtInt(t.count)} file${t.count === 1 ? '' : 's'}</div>
      </div>
      <div class="item-size">${fmtBytes(t.bytes)}</div>`;
    tl.appendChild(el);
  }

  // Skipped
  if (data.skipped && data.skipped.length) {
    $('skippedNote').textContent =
      `${fmtInt(data.skipped.length)} item(s) couldn't be read (permissions) and were ignored.`;
  } else {
    $('skippedNote').textContent = '';
  }

  show('results');
}

// --- events ---------------------------------------------------------------
$('pickBtn').addEventListener('click', async () => {
  const target = await window.diskdive.pickFolder();
  if (target) runScan(target);
});

$('rescanBtn').addEventListener('click', () => {
  if (lastTarget) runScan(lastTarget);
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    for (const name of ['candidates', 'largest', 'types']) {
      $(`tab-${name}`).classList.toggle('hidden', name !== tab.dataset.tab);
    }
  });
});

// Reveal buttons (event delegation)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.reveal');
  if (!btn) return;
  window.diskdive.reveal(btn.dataset.path);
});

// Live progress
window.diskdive.onProgress((p) => {
  $('progressText').textContent =
    `Scanning… ${fmtInt(p.files)} files · ${fmtBytes(p.bytes)}`;
});
