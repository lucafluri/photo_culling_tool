"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  photos: [],          // all photos {path, filename, flag, rating}
  view: [],            // filtered list currently shown (array of photo objs)
  byPath: new Map(),   // path -> photo obj
  cursor: 0,           // index into S.view
  filter: "all",
  typeFilter: "all",   // "all" | "raw" | "heic" | "std" | ".jpg" ...
  sortKey: "name",     // name | taken | mtime | size | rating
  sortDir: -1,         // 1 asc, -1 desc (default: filename descending = newest first)
  compare: [],         // ordered list of paths in the compare set
  viewer: null,        // null | {mode:'loupe'|'compare', paths:[], cur:int, zoom, panx, pany}
  folder: null,        // currently open folder
  haveTrash: false,    // server can send to recycle bin
  mouseMode: false,    // hotkeys act on the hovered photo
  hover: null,         // hovered grid index (mouse mode)
  groupRaw: true,      // combine same-named RAW + JPEG into one item
  editor: null,        // null | {path, showOrig} — active loupe editor
  cropMode: false,     // drawing a crop box
  showMeta: true,      // EXIF info panel visible in loupe (default on)
  showGrid: true,      // alignment grid overlay in edit mode (default on)
  showHist: true,      // RGB histogram panel visible in loupe (default on)
};

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const viewer = $("viewer");
const panesEl = $("panes");

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// `_ev` (edit version) bumps when a photo's stored edits change, busting the
// browser cache for its thumb/preview without touching the server cache key.
function verSuffix(path) {
  const x = S.byPath.get(path);
  return x && x._ev ? "&v=" + x._ev : "";
}
const thumbUrl = (p) => "/api/thumb?path=" + encodeURIComponent(p) + verSuffix(p);
// Pass `editsObj` to render a live editor preview of those exact edits; omit it
// to show the photo's stored edits.
function previewUrl(p, editsObj) {
  let u = "/api/preview?path=" + encodeURIComponent(p);
  if (editsObj !== undefined) u += "&edits=" + encodeURIComponent(JSON.stringify(editsObj || {}));
  else u += verSuffix(p);
  return u;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastT = null;
function toast(msg, ms = 1600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------------------------------------------------------------------------
// Loading folders
// ---------------------------------------------------------------------------
const RAW_EXTS = new Set([".cr2", ".cr3", ".nef", ".arw", ".raf", ".rw2", ".dng",
  ".orf", ".pef", ".srw", ".raw", ".kdc", ".dcr", ".nrw", ".sr2", ".srf", ".x3f",
  ".erf", ".mef", ".mos", ".mrw", ".3fr"]);
const HEIC_EXTS = new Set([".heic", ".heif"]);

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}
function typeGroup(ext) {
  if (RAW_EXTS.has(ext)) return "raw";
  if (HEIC_EXTS.has(ext)) return "heic";
  return "std";
}

function ingest(photos) {
  // a fresh folder load starts with no carried-over compare selection
  S.compare = [];
  S.cursor = 0;
  S.photos = photos;
  S.byPath = new Map();
  for (const p of photos) {
    p.ext = extOf(p.filename);
    if (typeof p.edits === "string") { try { p.edits = JSON.parse(p.edits); } catch (e) { p.edits = null; } }
    S.byPath.set(p.path, p);
  }
  buildGroups();
  populateTypeFilter();
  sortPhotos();   // also calls applyFilter()
}

// Base name (filename minus extension), lower-cased, for pairing.
function baseName(p) {
  return p.filename.slice(0, p.filename.length - p.ext.length).toLowerCase();
}

// Within a folder, files sharing a base name (e.g. IMG_001.JPG + IMG_001.CR2)
// are one item. We keep a single visible "primary" cell carrying the member
// paths; the others are flagged _hidden and dropped from the view. All marks
// are propagated to every member (see mark()), so server-side export/delete —
// which key off the flag column — act on the whole group automatically.
function buildGroups() {
  for (const p of S.photos) {
    p.members = null; p.groupExts = null; p._hidden = false;
    p.hasRaw = p.hasStd = p.hasHeic = false;
  }
  if (!S.groupRaw) return;

  const map = new Map();   // "folder|base" -> [photos]
  for (const p of S.photos) {
    const key = (p.folder || "") + "|" + baseName(p);
    (map.get(key) || map.set(key, []).get(key)).push(p);
  }
  const order = (p) => typeGroup(p.ext) === "std" ? 0 : (HEIC_EXTS.has(p.ext) ? 1 : 2);
  for (const members of map.values()) {
    // only pair up when a RAW is involved (the RAW+JPEG sidecar case)
    if (members.length < 2 || !members.some((m) => RAW_EXTS.has(m.ext))) continue;
    // primary = a standard image if present (fast thumbnail), else first by name
    members.sort((a, b) => order(a) - order(b) ||
      a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    const primary = members[0];
    primary.members = members.map((m) => m.path);
    primary.groupExts = members.map((m) => m.ext);
    primary.hasRaw = members.some((m) => RAW_EXTS.has(m.ext));
    primary.hasStd = members.some((m) => typeGroup(m.ext) === "std");
    primary.hasHeic = members.some((m) => HEIC_EXTS.has(m.ext));
    // reconcile display state to the strongest member mark
    primary.rating = Math.max(...members.map((m) => m.rating || 0));
    const rej = members.find((m) => m.flag === -1);
    const keep = members.find((m) => m.flag === 1);
    primary.flag = primary.flag || (rej ? -1 : keep ? 1 : 0);
    for (let i = 1; i < members.length; i++) members[i]._hidden = true;
  }
}

function visiblePhotos() { return S.photos.filter((p) => !p._hidden); }

function sortKeyVal(p) {
  switch (S.sortKey) {
    case "taken": return (p.taken != null ? p.taken : p.mtime) || 0;
    case "mtime": return p.mtime || 0;
    case "size": return p.size || 0;
    case "rating": return p.rating || 0;
    default: return null;  // name -> handled by localeCompare
  }
}

function sortPhotos() {
  // keep the currently-selected photo selected after re-sorting
  const curPath = S.view[S.cursor] ? S.view[S.cursor].path : null;
  const dir = S.sortDir;
  S.photos.sort((a, b) => {
    let c;
    if (S.sortKey === "name") {
      c = a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: "base" });
    } else {
      c = sortKeyVal(a) - sortKeyVal(b);
    }
    if (c === 0) c = a.filename.localeCompare(b.filename, undefined, { numeric: true });
    return c * dir;
  });
  applyFilter();
  if (curPath) {
    const ni = S.view.findIndex((p) => p.path === curPath);
    if (ni >= 0) setCursor(ni, true);
  }
}

function populateTypeFilter() {
  const exts = {};        // ext -> count
  const groups = new Set();
  for (const p of S.photos) {
    exts[p.ext] = (exts[p.ext] || 0) + 1;
    groups.add(typeGroup(p.ext));
  }
  const sel = $("typeSel");
  const prev = S.typeFilter;
  let html = '<option value="all">All types (' + S.photos.length + ")</option>";
  // group shortcuts, only when more than one type family is present
  if (groups.size > 1) {
    const gcount = { raw: 0, heic: 0, std: 0 };
    for (const p of S.photos) gcount[typeGroup(p.ext)]++;
    if (gcount.raw) html += '<option value="raw">All RAW (' + gcount.raw + ")</option>";
    if (gcount.std) html += '<option value="std">Standard (' + gcount.std + ")</option>";
    if (gcount.heic) html += '<option value="heic">HEIC (' + gcount.heic + ")</option>";
  }
  Object.keys(exts).sort().forEach((e) => {
    const label = e ? e.slice(1).toUpperCase() : "(no ext)";
    html += '<option value="' + e + '">' + label + " (" + exts[e] + ")</option>";
  });
  sel.innerHTML = html;
  // keep previous selection if still valid, else reset
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else { S.typeFilter = "all"; sel.value = "all"; }
}

function setFolderLabel(folder) {
  S.folder = folder || null;
  const el = $("folderPath");
  el.textContent = folder || "No folder open";
  el.title = folder || "";
}

async function scanFolder(folder) {
  if (!folder) return;
  toast("Scanning…", 8000);
  try {
    const res = await post("/api/open", { folder, recursive: $("recursive").checked });
    setFolderLabel(res.folder);
    ingest(res.photos);
    toast(res.photos.length + " images");
  } catch (e) { toast("Error: " + e.message, 4000); }
}

// Native OS folder picker; returns the chosen path or null. Callers decide what
// to do with it (scan a library, fill the export dest, …).
async function pickFolder() {
  try {
    return (await api("/api/pick-folder")).folder || null;
  } catch (e) { toast("Folder picker failed: " + e.message, 4000); return null; }
}

async function browseFolder() {
  const folder = await pickFolder();
  if (folder) scanFolder(folder);
}

function reloadFolder() {
  if (S.folder) scanFolder(S.folder);
  else browseFolder();
}

async function restore() {
  try {
    const st = await api("/api/state");
    setFolderLabel(st.folder);
    S.haveTrash = !!st.have_trash;
    $("recursive").checked = st.recursive !== false;
    if (st.photos && st.photos.length) {
      ingest(st.photos);
      toast(st.photos.length + " images restored");
    } else {
      renderGrid();
    }
  } catch (e) { renderGrid(); }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
function matchesFlag(p, f) {
  switch (f) {
    case "keep": return p.flag === 1;
    case "reject": return p.flag === -1;
    case "unflagged": return p.flag === 0;
    case "rated1": return p.rating >= 1;
    case "rated3": return p.rating >= 3;
    case "rated5": return p.rating >= 5;
    default: return true;
  }
}
function matchesType(p, t) {
  if (t === "all") return true;
  const exts = (p.members && p.members.length) ? p.groupExts : [p.ext];
  if (t === "raw" || t === "heic" || t === "std") return exts.some((e) => typeGroup(e) === t);
  return exts.includes(t);  // exact extension
}
function matches(p) {
  if (p._hidden) return false;
  return matchesFlag(p, S.filter) && matchesType(p, S.typeFilter);
}
function applyFilter() {
  S.view = S.photos.filter(matches);
  S.cursor = Math.min(S.cursor, Math.max(0, S.view.length - 1));
  renderGrid();
  updateCounts();
}

function updateCounts() {
  let keep = 0, reject = 0, rated = 0;
  const vis = visiblePhotos();
  for (const p of vis) {
    if (p.flag === 1) keep++;
    else if (p.flag === -1) reject++;
    if (p.rating > 0) rated++;
  }
  const left = vis.length - keep - reject;
  $("counts").innerHTML =
    `<b>${vis.length}</b> photos · <b style="color:var(--keep)">${keep}</b> keep · ` +
    `<b style="color:var(--reject)">${reject}</b> reject · ` +
    (left || !vis.length ? `<b>${left}</b> to cull · ` : `<b style="color:var(--keep)">done</b> · `) +
    `<b>${rated}</b> rated` +
    (S.compare.length ? ` · <b style="color:var(--star)">${S.compare.length}</b> compare` : "");
}

// ---------------------------------------------------------------------------
// Grid rendering (lazy thumbnails)
// ---------------------------------------------------------------------------
let io = null;
function ensureObserver() {
  if (io) return;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const img = e.target;
        if (!img.src && img.dataset.src) img.src = img.dataset.src;
        io.unobserve(img);
      }
    }
  }, { root: grid, rootMargin: "400px" });
}

function starStr(n) { return n > 0 ? "★".repeat(n) : ""; }

function cellClass(p) {
  let c = "cell";
  if (p.flag === 1) c += " flag-keep";
  else if (p.flag === -1) c += " flag-reject";
  return c;
}

function typeBadge(p) {
  if (p.members && p.members.length > 1) {
    const parts = [];
    if (p.hasStd) parts.push("JPG");
    if (p.hasRaw) parts.push("RAW");
    if (p.hasHeic) parts.push("HEIC");
    const title = p.groupExts.join(", ");
    return `<div class="typebadge combo" title="${title}">${parts.join("+")}</div>`;
  }
  const g = typeGroup(p.ext);
  if (g === "std") return "";
  const label = p.ext ? p.ext.slice(1).toUpperCase() : "";
  return `<div class="typebadge ${g}">${label}</div>`;
}

function renderGrid() {
  ensureObserver();
  grid.innerHTML = "";
  if (!S.view.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = S.photos.length ? "No photos match this filter." :
      "Click “Choose folder…” above to open a photo folder.";
    grid.appendChild(d);
    return;
  }
  const frag = document.createDocumentFragment();
  S.view.forEach((p, i) => {
    const cell = document.createElement("div");
    cell.className = cellClass(p);
    cell.dataset.i = i;
    const cmpIdx = S.compare.indexOf(p.path);
    cell.innerHTML =
      `<img data-src="${thumbUrl(p.path)}" alt="" />` +
      `<div class="name">${p.filename}</div>` +
      typeBadge(p) +
      (p.edits ? `<div class="editbadge" title="Edited">✎</div>` : "") +
      (cmpIdx >= 0 ? `<div class="cmpnum">${cmpIdx + 1}</div>` : "") +
      `<div class="badges"><span class="flag"></span><span class="stars">${starStr(p.rating)}</span></div>`;
    if (i === S.cursor) cell.classList.add("sel");
    if (cmpIdx >= 0) cell.classList.add("cmp");
    cell.addEventListener("click", () => { setCursor(i); });
    cell.addEventListener("dblclick", () => openLoupe(i));
    cell.addEventListener("mouseenter", () => { if (S.mouseMode) setHover(i); });
    cell.addEventListener("mouseleave", () => { if (S.hover === i) setHover(null); });
    frag.appendChild(cell);
    io.observe(cell.querySelector("img"));
  });
  grid.appendChild(frag);
  const selCell = grid.querySelector(`.cell[data-i="${S.cursor}"]`);
  if (selCell) scrollCellIntoView(selCell);
}

// update a single cell in place (after marking) without full re-render
function refreshCell(i) {
  const cell = grid.querySelector(`.cell[data-i="${i}"]`);
  if (!cell) return;
  const p = S.view[i];
  cell.className = cellClass(p) + (i === S.cursor ? " sel" : "");
  const cmpIdx = S.compare.indexOf(p.path);
  if (cmpIdx >= 0) cell.classList.add("cmp");
  cell.querySelector(".stars").textContent = starStr(p.rating);
  let eb = cell.querySelector(".editbadge");
  if (p.edits && !eb) {
    eb = document.createElement("div");
    eb.className = "editbadge"; eb.title = "Edited"; eb.textContent = "✎";
    cell.appendChild(eb);
  } else if (!p.edits && eb) { eb.remove(); }
  let num = cell.querySelector(".cmpnum");
  if (cmpIdx >= 0) {
    if (!num) { num = document.createElement("div"); num.className = "cmpnum"; cell.appendChild(num); }
    num.textContent = cmpIdx + 1;
  } else if (num) { num.remove(); }
}

function setCursor(i, scroll = true) {
  if (!S.view.length) return;
  i = Math.max(0, Math.min(S.view.length - 1, i));
  const prev = S.cursor;
  S.cursor = i;
  const a = grid.querySelector(`.cell[data-i="${prev}"]`);
  if (a) a.classList.remove("sel");
  const b = grid.querySelector(`.cell[data-i="${i}"]`);
  if (b) { b.classList.add("sel"); if (scroll) scrollCellIntoView(b); }
}

// Keep a cell within the #grid scroll viewport (reliable with CSS grid).
// offsetTop is measured from #grid (its positioned offset parent), so it
// lines up directly with grid.scrollTop — no viewport/header math.
function scrollCellIntoView(cell) {
  const pad = 12;
  const top = cell.offsetTop;
  const bottom = top + cell.offsetHeight;
  const viewTop = grid.scrollTop;
  const viewBottom = viewTop + grid.clientHeight;
  if (top - pad < viewTop) {
    grid.scrollTop = Math.max(0, top - pad);
  } else if (bottom + pad > viewBottom) {
    grid.scrollTop = bottom + pad - grid.clientHeight;
  }
}

function columns() {
  const style = getComputedStyle(grid);
  return style.gridTemplateColumns.split(" ").length;
}

function setHover(i) {
  const old = S.hover;
  if (old != null) {
    const c = grid.querySelector(`.cell[data-i="${old}"]`);
    if (c) c.classList.remove("hover");
  }
  S.hover = i;
  if (i != null && S.mouseMode) {
    const c = grid.querySelector(`.cell[data-i="${i}"]`);
    if (c) c.classList.add("hover");
  }
}

function toggleMouseMode(on) {
  S.mouseMode = (on === undefined) ? !S.mouseMode : !!on;
  document.body.classList.toggle("mousemode", S.mouseMode);
  $("mouseBtn").classList.toggle("active", S.mouseMode);
  if (!S.mouseMode) setHover(null);
  toast(S.mouseMode ? "Mouse mode ON — hotkeys act on the hovered photo" : "Mouse mode off");
}

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------
// Undo stack for flag/rating changes: each entry is one user action — a list
// of {path, flag, rating} snapshots taken BEFORE the change. U restores one.
const markHist = [];
function snapshotMarks(paths) {
  const seen = new Set();
  const items = [];
  for (const pp of paths) {
    const p = S.byPath.get(pp);
    if (!p) continue;
    for (const tp of (p.members && p.members.length ? p.members : [pp])) {
      if (seen.has(tp)) continue;
      seen.add(tp);
      const t = S.byPath.get(tp);
      if (t) items.push({ path: tp, flag: t.flag, rating: t.rating });
    }
  }
  if (items.length) {
    markHist.push(items);
    if (markHist.length > 100) markHist.shift();
  }
}

function undoMark() {
  const last = markHist.pop();
  if (!last) { toast("Nothing to undo"); return; }
  for (const it of last) {
    const t = S.byPath.get(it.path);
    if (!t) continue;
    t.flag = it.flag; t.rating = it.rating;
    const vi = S.view.indexOf(t);
    if (vi >= 0) refreshCell(vi);
    post("/api/mark", { path: it.path, flag: it.flag, rating: it.rating })
      .catch((e) => toast("Save failed: " + e.message));
  }
  updateCounts();
  if (S.viewer) renderViewerMeta();
  toast("Mark undone");
}

async function mark(path, fields, record = true) {
  const p = S.byPath.get(path);
  if (!p) return;
  if (record) snapshotMarks([path]);
  // a grouped primary carries its member paths; mark them all so the RAW and
  // the JPEG stay in lock-step (and the server's flag-based ops hit both)
  const targets = (p.members && p.members.length) ? p.members : [path];
  for (const tp of targets) {
    const t = S.byPath.get(tp);
    if (!t) continue;
    if (fields.flag !== undefined) t.flag = fields.flag;
    if (fields.rating !== undefined) t.rating = fields.rating;
  }
  // reflect in UI immediately
  const vi = S.view.indexOf(p);
  if (vi >= 0) refreshCell(vi);
  if (S.viewer) renderViewerMeta();
  updateCounts();
  try {
    await Promise.all(targets.map((tp) =>
      post("/api/mark", { path: tp, flag: fields.flag, rating: fields.rating })));
  } catch (e) { toast("Save failed: " + e.message); }
}

// In the grid, hotkeys act on the hovered cell when mouse mode is on,
// otherwise on the keyboard cursor.
function activeIndex() {
  if (!S.viewer && S.mouseMode && S.hover != null) return S.hover;
  return S.cursor;
}

function currentPhoto() {
  if (S.viewer) {
    if (S.viewer.mode === "tournament") return S.byPath.get(S.viewer.left);
    return S.byPath.get(S.viewer.paths[S.viewer.cur]);
  }
  return S.view[activeIndex()];
}

function markCurrent(fields, advance) {
  const p = currentPhoto();
  if (!p) return;
  mark(p.path, fields);
  // don't auto-advance the cursor while the user is driving with the mouse
  if (advance && !(S.mouseMode && !S.viewer)) advanceCurrent();
}

function advanceCurrent() {
  if (S.viewer) {
    if (S.viewer.mode === "loupe" && S.viewer.cur < S.viewer.paths.length - 1)
      loupeGo(S.viewer.cur + 1);
  } else {
    setCursor(S.cursor + 1);
  }
}

// ---------------------------------------------------------------------------
// Compare set
// ---------------------------------------------------------------------------
function toggleCompare(path) {
  const i = S.compare.indexOf(path);
  if (i >= 0) S.compare.splice(i, 1);
  else { if (S.compare.length >= 16) { toast("Compare max 16"); return; } S.compare.push(path); }
  const vi = S.view.findIndex((p) => p.path === path);
  if (vi >= 0) refreshCell(vi);
  // renumber others
  S.view.forEach((p, idx) => { if (S.compare.includes(p.path)) refreshCell(idx); });
  updateCounts();
  updatePasteBtn();
}

// ---------------------------------------------------------------------------
// Viewer: loupe + compare with synced zoom/pan
// ---------------------------------------------------------------------------
function openLoupe(i) {
  if (!S.view.length) return;
  S.viewer = { mode: "loupe", paths: S.view.map((p) => p.path), cur: i,
               zoom: 1, panx: 0, pany: 0 };
  buildPanes();
}

// Home-row keys map to compare panes 1/2/3 for quick best-pick.
const PICK_KEYS = ["s", "d", "f"];

// Empty the compare set and re-render, keeping the grid scrolled where it was
// (clearing the selection should never jump the user back to the top).
function clearCompare(msg) {
  S.compare = [];
  const sy = grid.scrollTop;
  applyFilter();
  grid.scrollTop = sy;
  updatePasteBtn();
  if (msg) toast(msg);
}

// Finish a comparison: keep `winner`, reject everyone else in `contenders`,
// clear the compare set, close the viewer.
function finishCompare(winner, contenders) {
  snapshotMarks(contenders);   // one undo entry for the whole verdict
  contenders.forEach((path) => mark(path, { flag: path === winner ? 1 : -1 }, false));
  const w = S.byPath.get(winner);
  toast("Best: " + (w ? w.filename : "?") + " · rejected the other " + (contenders.length - 1));
  closeViewer();
  clearCompare();   // re-render (flags changed + compare numbers cleared), keep scroll
}

// Side-by-side pick (≤3 images): keep pane `idx`, reject the rest, finish.
function pickBest(idx) {
  const v = S.viewer;
  if (!v || v.mode !== "compare") return;
  const winner = v.paths[idx];
  if (!winner) return;
  finishCompare(winner, v.paths.slice());
}

function openCompare() {
  let paths = S.compare.slice();
  if (paths.length < 2) {
    // fall back to current + next few
    const start = S.cursor;
    paths = S.view.slice(start, start + 2).map((p) => p.path);
  }
  if (paths.length < 1) return;
  if (paths.length <= 3) {
    S.viewer = { mode: "compare", paths, cur: 0, zoom: 1, panx: 0, pany: 0 };
    buildPanes();
  } else {
    startTournament(paths);
  }
}

// ---------------------------------------------------------------------------
// Tournament: >3 images, decided by binary left/right votes (king-of-the-hill).
// The current champion stays on the left and defends against the next
// challenger on the right; the winner of each match defends the next, until
// one image has beaten all others.
// ---------------------------------------------------------------------------
function startTournament(paths) {
  S.viewer = {
    mode: "tournament",
    contenders: paths.slice(),  // every image in the bracket
    champ: paths[0],            // current champion (shown left)
    nextIdx: 1,                 // index of the next challenger in `contenders`
    left: paths[0],
    right: paths[1],
    round: 1,
    total: paths.length - 1,    // total matches needed
    cur: 0,                     // focal pane for zoom (always left)
    zoom: 1, panx: 0, pany: 0,
  };
  buildPanes();
}

function tournamentVote(side) {
  const v = S.viewer;
  if (!v || v.mode !== "tournament") return;
  v.champ = side === "right" ? v.right : v.left;
  v.nextIdx++;
  if (v.nextIdx >= v.contenders.length) {
    finishCompare(v.champ, v.contenders.slice());
    return;
  }
  v.round++;
  v.left = v.champ;
  v.right = v.contenders[v.nextIdx];
  v.zoom = 1; v.panx = 0; v.pany = 0;
  buildPanes();
}

// Which paths get a pane right now, in order.
function paneList() {
  const v = S.viewer;
  if (v.mode === "loupe") return [v.paths[v.cur]];
  if (v.mode === "tournament") return [v.left, v.right];
  return v.paths;
}

function buildPanes() {
  viewer.classList.remove("hidden");
  panesEl.innerHTML = "";
  const list = paneList();
  S.viewer._fit = [];
  list.forEach((path, idx) => {
    const pane = document.createElement("div");
    pane.className = "pane";
    pane.dataset.idx = idx;
    const img = document.createElement("img");
    img.src = previewUrl(path);
    img.draggable = false;
    img.onload = () => { computeFit(idx, pane, img); applyTransform(); drawHistogram(); };
    const label = document.createElement("div");
    label.className = "plabel";
    pane.appendChild(label);
    pane.appendChild(img);
    // best-pick hotkey badge (compare, ≤3 images)
    if (S.viewer.mode === "compare" && list.length <= 3) {
      const pk = document.createElement("div");
      pk.className = "pickkey";
      const key = (PICK_KEYS[idx] || "").toUpperCase();
      pk.innerHTML = `<kbd>${key}</kbd> keep this`;
      pk.title = "Press " + key + " to keep this and reject the others";
      pk.addEventListener("mousedown", (e) => e.stopPropagation());
      pk.addEventListener("click", (e) => { e.stopPropagation(); pickBest(idx); });
      pane.appendChild(pk);
    }
    // tournament vote badge (left vs right)
    if (S.viewer.mode === "tournament") {
      const isLeft = idx === 0;
      const pk = document.createElement("div");
      pk.className = "pickkey";
      pk.innerHTML = isLeft
        ? `<kbd>S</kbd> / <kbd>←</kbd> better`
        : `better <kbd>F</kbd> / <kbd>→</kbd>`;
      pk.title = "Vote this image as the better of the two";
      pk.addEventListener("mousedown", (e) => e.stopPropagation());
      pk.addEventListener("click", (e) => { e.stopPropagation(); tournamentVote(isLeft ? "left" : "right"); });
      pane.appendChild(pk);
    }
    pane._img = img; pane._label = label;
    attachPaneHandlers(pane, idx);
    panesEl.appendChild(pane);
  });
  // editor is ambient in loupe (single image), hidden in compare/tournament
  if (S.viewer.mode === "loupe") {
    bindEditor(S.viewer.paths[S.viewer.cur]);
    if (S.showMeta) renderMeta(); else $("metaPanel").classList.add("hidden");
    preloadNeighbors();
    drawHistogram();
  } else {
    S.editor = null;
    $("editBar").classList.add("hidden");
    $("metaPanel").classList.add("hidden");
    $("histPanel").classList.add("hidden");
  }
  // the sidebar just appeared/disappeared, changing the pane's available
  // width before any image has necessarily loaded — refit defensively
  refitPanes();
  renderViewerMeta();
}

function computeFit(idx, pane, img) {
  const PW = pane.clientWidth, PH = pane.clientHeight;
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return;
  S.viewer._fit[idx] = { fit: Math.min(PW / nw, PH / nh), nw, nh, PW, PH };
}

// JS twin of the server's _max_inscribed: largest axis-aligned rect inside a
// w×h rect rotated by `deg`. Used to zoom the live straighten preview so it
// shows the same framing the server will crop to.
function maxInscribed(w, h, deg) {
  const a = Math.abs(deg) * Math.PI / 180;
  const sin = Math.sin(a), cos = Math.cos(a);
  const longS = Math.max(w, h), shortS = Math.min(w, h);
  if (shortS <= 2 * sin * cos * longS || Math.abs(sin - cos) < 1e-10) {
    const x = 0.5 * shortS;
    return w >= h ? [x / sin, x / cos] : [x / cos, x / sin];
  }
  const cos2 = cos * cos - sin * sin;
  return [(w * cos - h * sin) / cos2, (h * cos - w * sin) / cos2];
}

function applyTransform() {
  const v = S.viewer;
  if (!v) return;
  for (const pane of panesEl.children) {
    const idx = +pane.dataset.idx;
    const f = v._fit[idx];
    const img = pane._img;
    if (!f) continue;
    let scale = f.fit * v.zoom;
    const cx = f.PW / 2 + v.panx;
    const cy = f.PH / 2 + v.pany;
    let rot = "";
    // live straighten: rotate + zoom to the inscribed rect while dragging
    const lf = (idx === 0 && S.editor && S.editor.liveFine) ? S.editor.liveFine : 0;
    if (lf) {
      const [wr, hr] = maxInscribed(f.nw, f.nh, lf);
      scale = v.zoom * Math.min(f.PW / wr, f.PH / hr);
      rot = ` rotate(${lf}deg)`;
    }
    img.style.transform =
      `translate(${cx}px, ${cy}px)${rot} scale(${scale}) translate(${-f.nw / 2}px, ${-f.nh / 2}px)`;
  }
}

function zoomAt(screenX, screenY, factor) {
  const v = S.viewer;
  const pane = panesEl.children[v.mode === "loupe" ? 0 : Math.max(0, v.cur)];
  const r = pane.getBoundingClientRect();
  const f = v._fit[+pane.dataset.idx];
  if (!f) return;
  const old = v.zoom;
  let nz = Math.max(1, Math.min(16, old * factor));
  const ratio = nz / old;
  if (ratio === 1) return;
  // cursor relative to pane center
  const dx = (screenX - r.left) - f.PW / 2;
  const dy = (screenY - r.top) - f.PH / 2;
  v.panx = v.panx + (dx - v.panx) * (1 - ratio);
  v.pany = v.pany + (dy - v.pany) * (1 - ratio);
  v.zoom = nz;
  if (nz === 1) { v.panx = 0; v.pany = 0; }
  applyTransform();
  updateHud();
}

function resetZoom() {
  if (!S.viewer) return;
  S.viewer.zoom = 1; S.viewer.panx = 0; S.viewer.pany = 0;
  applyTransform(); updateHud();
}

// One window-level drag handler for all panes (panes are rebuilt constantly;
// per-pane window listeners would pile up and never be removed).
let paneDrag = null;   // {pane, lx, ly} while the mouse is panning a pane
window.addEventListener("mousemove", (e) => {
  if (!paneDrag || !S.viewer) return;
  S.viewer.panx += e.clientX - paneDrag.lx;
  S.viewer.pany += e.clientY - paneDrag.ly;
  paneDrag.lx = e.clientX; paneDrag.ly = e.clientY;
  applyTransform();
});
window.addEventListener("mouseup", () => {
  if (paneDrag) { paneDrag.pane.classList.remove("grabbing"); paneDrag = null; }
});

function attachPaneHandlers(pane, idx) {
  pane.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (S.viewer.mode === "compare") S.viewer.cur = idx;
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(e.clientX, e.clientY, factor);
    markCurPane();
  }, { passive: false });

  pane.addEventListener("mousedown", (e) => {
    if (S.viewer.mode === "compare") { S.viewer.cur = idx; markCurPane(); }
    paneDrag = { pane, lx: e.clientX, ly: e.clientY };
    pane.classList.add("grabbing");
  });
  pane.addEventListener("dblclick", () => resetZoom());
}

function markCurPane() {
  if (S.viewer.mode !== "compare") return;
  [...panesEl.children].forEach((p) => p.classList.toggle("cur", +p.dataset.idx === S.viewer.cur));
  renderViewerMeta();
}

// warm the browser (and server render) cache for the neighbours of the
// current loupe image so S/F navigation feels instant
function preloadNeighbors() {
  const v = S.viewer;
  if (!v || v.mode !== "loupe") return;
  for (const i of [v.cur + 1, v.cur - 1]) {
    if (v.paths[i]) new Image().src = previewUrl(v.paths[i]);
  }
}

function loupeGo(i) {
  const v = S.viewer;
  v.cur = Math.max(0, Math.min(v.paths.length - 1, i));
  // reset zoom/pan up front so the next frame is never inherited from the last
  v.zoom = 1; v.panx = 0; v.pany = 0;
  const pane = panesEl.children[0];
  const img = pane._img;
  img.style.filter = ""; img.style.border = "";   // drop any live edit layers
  const url = previewUrl(v.paths[v.cur]);
  img.onload = () => { computeFit(0, pane, img); applyTransform(); updateHud(); drawHistogram(); };
  if (img.getAttribute("src") !== url) img.src = url;
  // if it's already cached/complete, onload may not fire — fit now
  if (img.complete && img.naturalWidth) computeFit(0, pane, img);
  applyTransform();
  updateHud();
  // keep grid cursor in sync
  const gi = S.view.findIndex((p) => p.path === v.paths[v.cur]);
  if (gi >= 0) setCursor(gi, true);
  if (S.editor) bindEditor(v.paths[v.cur]);   // editor follows the current photo
  renderViewerMeta();
  if (S.showMeta) renderMeta();
  preloadNeighbors();
  drawHistogram();
}

// ---- EXIF info panel (I), on by default ----
function toggleMeta() {
  S.showMeta = !S.showMeta;
  localStorage.setItem("showMeta", S.showMeta ? "1" : "0");
  if (S.showMeta) renderMeta();
  else $("metaPanel").classList.add("hidden");
}

async function renderMeta() {
  const p = currentPhoto();
  if (!p || !S.viewer || S.viewer.mode !== "loupe") return;
  const el = $("metaPanel");
  el.classList.remove("hidden");
  el.innerHTML = `<div class="mrow"><span class="mkey">Loading…</span></div>`;
  try {
    const m = await api("/api/meta?path=" + encodeURIComponent(p.path));
    const cur = currentPhoto();   // user may have navigated meanwhile
    if (!S.showMeta || !cur || cur.path !== p.path) return;
    const rows = [
      ["Camera", m.camera],
      ["Lens", m.lens],
      ["Focal", m.focal],
      ["Shutter", m.shutter],
      ["Aperture", m.aperture],
      ["ISO", m.iso && String(m.iso).replace(/^ISO /, "")],
      ["Size", m.width ? `${m.width} × ${m.height}` : null],
      ["File", (m.size / 1048576).toFixed(1) + " MB"],
      ["Taken", p.taken ? new Date(p.taken * 1000).toLocaleString() : null],
    ].filter(([, v]) => v);
    el.innerHTML = rows.map(([k, v]) =>
      `<div class="mrow"><span class="mkey">${k}</span><span>${v}</span></div>`).join("") ||
      `<div class="mrow"><span class="mkey">No EXIF data</span></div>`;
  } catch (e) {
    el.innerHTML = `<div class="mrow"><span class="mkey">No EXIF data</span></div>`;
  }
}

// ---- histogram (H): live RGB histogram of the current pane, with a white
// "before" outline of the unedited original overlaid so any edit's effect —
// auto-levels included, but this works for all of them — is visible at a
// glance. Computed client-side from the already-loaded preview image, no
// extra server work beyond one cached fetch of the original per photo. ----
function toggleHist() {
  S.showHist = !S.showHist;
  localStorage.setItem("showHist", S.showHist ? "1" : "0");
  $("histBtn").classList.toggle("active", S.showHist);
  drawHistogram();
}

// downsize onto a small offscreen canvas before sampling — a histogram is a
// statistical summary, full preview resolution buys nothing but slower reads
function sampleImageData(img, maxDim = 160) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
  const c = document.createElement("canvas");
  c.width = sw; c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, sw, sh);
  try { return ctx.getImageData(0, 0, sw, sh).data; }
  catch (e) { return null; }
}
function channelHist(data) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) { r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++; }
  return { r, g, b };
}
function lumaHist(data) {
  const l = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    l[(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0]++;
  }
  return l;
}
function channelMeans(data) {
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) { rs += data[i]; gs += data[i + 1]; bs += data[i + 2]; n++; }
  return n ? { r: rs / n, g: gs / n, b: bs / n } : null;
}

// Rough conversion of a channel-gain shift into Fujifilm's on-camera WB
// fine-tune units (R/B axes, typically -9..+9). Fuji doesn't publish the
// exact per-unit gain, so this assumes ~2% channel gain per step — close
// enough to be a useful starting point, not a calibrated match.
function fujiWbShift(fromMeans, toMeans) {
  if (!fromMeans || !toMeans || !fromMeans.r || !fromMeans.b) return null;
  const toUnits = (pct) => Math.max(-9, Math.min(9, Math.round(pct / 2)));
  const ru = toUnits((toMeans.r / fromMeans.r - 1) * 100);
  const bu = toUnits((toMeans.b / fromMeans.b - 1) * 100);
  if (!ru && !bu) return null;
  const fmt = (n) => (n > 0 ? `+${n}` : String(n));
  return `R${fmt(ru)} B${fmt(bu)}`;
}
function drawHistCurve(ctx, hist, w, h, color, fill) {
  const max = Math.max(1, ...hist);   // log scale: one blown-out spike shouldn't flatten the rest
  ctx.beginPath();
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * w;
    const y = h - (Math.log1p(hist[i]) / Math.log1p(max)) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  if (fill) {
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
  } else {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

// caches of per-photo stats computed from a fetched preview — the file's
// pixels never change, so these are stable for the whole session; capped so
// a long shoot doesn't grow them without bound
const histCache = new Map();     // path -> {luma, means} of the ORIGINAL (edits={})
const autoCache = new Map();     // path -> means of the AUTO-LEVELS-ONLY render
function capCache(cache, path, val) {
  cache.set(path, val);
  if (cache.size > 50) cache.delete(cache.keys().next().value);
}
// fetch `previewUrl(path, edits)`, run `compute` on its sampled pixels, cache by path in `cache`
function statsFromPreview(cache, path, edits, compute) {
  if (cache.has(path)) return Promise.resolve(cache.get(path));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const pixels = sampleImageData(img);
      const val = pixels ? compute(pixels) : null;
      capCache(cache, path, val);
      resolve(val);
    };
    img.onerror = () => { capCache(cache, path, null); resolve(null); };
    img.src = previewUrl(path, edits);
  });
}
const getOrigStats = (path) =>
  statsFromPreview(histCache, path, {}, (px) => ({ luma: lumaHist(px), means: channelMeans(px) }));
const getAutoOnlyMeans = (path) =>
  statsFromPreview(autoCache, path, { auto: true }, channelMeans);

// plain-English diff of the edit stack vs. the untouched original — this is
// what actually answers "what did auto (or anything else) change", the
// histogram only shows the tonal shift that results from it
function describeEdits(edits) {
  if (!edits) return [];
  const out = [];
  if (edits.rot) out.push(`Rotate ${edits.rot}°`);
  if (edits.fine) out.push(`Straighten ${edits.fine > 0 ? "+" : ""}${edits.fine}°`);
  if (edits.flipH) out.push("Flip horizontal");
  if (edits.flipV) out.push("Flip vertical");
  if (edits.crop) out.push("Cropped");
  if (edits.auto) out.push("Auto-levels");
  if (edits.wbR) out.push(`WB Red ${edits.wbR > 0 ? "+" : ""}${edits.wbR.toFixed(2)}`);
  if (edits.wbB) out.push(`WB Blue ${edits.wbB > 0 ? "+" : ""}${edits.wbB.toFixed(2)}`);
  if (edits.temp) out.push(`White balance (legacy) ${edits.temp > 0 ? "+" : ""}${edits.temp.toFixed(2)}`);
  if (edits.bright != null && edits.bright !== 1) out.push(`Brightness ×${edits.bright.toFixed(2)}`);
  if (edits.contrast != null && edits.contrast !== 1) out.push(`Contrast ×${edits.contrast.toFixed(2)}`);
  if (edits.saturation != null && edits.saturation !== 1) out.push(`Saturation ×${edits.saturation.toFixed(2)}`);
  if (edits.sharpness != null && edits.sharpness !== 1) out.push(`Sharpness ×${edits.sharpness.toFixed(2)}`);
  if (edits.border && edits.border.w) out.push(`Border ${Math.round(edits.border.w * 100)}% ${edits.border.color}`);
  return out;
}

async function drawHistogram() {
  const panel = $("histPanel");
  if (!S.showHist || !S.editor || !S.viewer || S.viewer.mode !== "loupe") {
    panel.classList.add("hidden");
    return;
  }
  const pane = panesEl.children[0];
  if (!pane || !pane._img || !pane._img.naturalWidth) return;
  panel.classList.remove("hidden");
  const canvas = $("histCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const data = sampleImageData(pane._img);
  if (data) {
    const { r, g, b } = channelHist(data);
    ctx.globalCompositeOperation = "lighter";
    drawHistCurve(ctx, r, w, h, "rgba(255,80,80,.55)", true);
    drawHistCurve(ctx, g, w, h, "rgba(80,255,120,.55)", true);
    drawHistCurve(ctx, b, w, h, "rgba(90,140,255,.55)", true);
    ctx.globalCompositeOperation = "source-over";
  }

  const p = editorPhoto();
  const list = describeEdits(p ? p.edits : null);

  if (p && p.edits) {   // nothing to compare against when there are no edits
    const wantAuto = !!p.edits.auto;
    const [orig, autoMeans] = await Promise.all([
      getOrigStats(p.path),
      wantAuto ? getAutoOnlyMeans(p.path) : Promise.resolve(null),
    ]);
    if (!S.showHist || editorPhoto() !== p) return;   // stale after the await
    if (orig) {
      drawHistCurve(ctx, orig.luma, w, h, "rgba(255,255,255,.85)", false);
      if (wantAuto && autoMeans) {
        const wb = fujiWbShift(orig.means, autoMeans);
        if (wb) list.push(`Fuji WB to match Auto: ${wb} (approx.)`);
      }
    }
  }

  $("histChanges").innerHTML = list.length
    ? list.map((s) => `<div class="hchg">${s}</div>`).join("")
    : `<div class="hchg muted">No edits — this is the original</div>`;
}

function renderViewerMeta() {
  if (!S.viewer) return;
  const v = S.viewer;
  const list = paneList();
  [...panesEl.children].forEach((pane) => {
    const idx = +pane.dataset.idx;
    const path = list[idx];
    const p = S.byPath.get(path);
    if (!p) return;
    const flag = p.flag === 1 ? `<span class="pflag keep">KEEP</span>`
      : p.flag === -1 ? `<span class="pflag reject">REJECT</span>` : "";
    pane._label.innerHTML =
      `<span class="nm">${typeBadge(p)}${p.filename}</span>` +
      `<span>${flag} <span class="stars" style="color:var(--star)">${starStr(p.rating)}</span></span>`;
    pane.classList.toggle("cur", v.mode === "compare" && idx === v.cur);
  });
  updateHud();
}

function updateHud() {
  const v = S.viewer; if (!v) return;
  if (v.mode === "tournament") {
    const l = S.byPath.get(v.left), r = S.byPath.get(v.right);
    $("viewerHud").innerHTML =
      `<span>Which is better? <b>${l ? l.filename : ""}</b> vs <b>${r ? r.filename : ""}</b></span>` +
      `<span>match ${v.round}/${v.total} · ←/S = left · →/F = right · Esc cancels</span>`;
    return;
  }
  const p = currentPhoto();
  const pos = v.mode === "loupe" ? `${v.cur + 1}/${v.paths.length}` : `compare ${v.paths.length}`;
  $("viewerHud").innerHTML =
    `<span>${p ? p.filename : ""}</span>` +
    `<span>${pos} · zoom ${(v.zoom).toFixed(1)}× · scroll=zoom drag=pan · Esc to close</span>`;
}

function closeViewer() {
  S.viewer = null;
  S.editor = null; S.cropMode = false;
  const ov = document.getElementById("cropOverlay");
  if (ov) ov.remove();
  $("editBar").classList.add("hidden");
  $("editBar").classList.remove("collapsed-full");   // sidebar hide is transient, not a saved preference
  S.sidebarCollapsed = false;
  $("metaPanel").classList.add("hidden");
  $("histPanel").classList.add("hidden");
  viewer.classList.add("hidden");
  panesEl.innerHTML = "";
}

window.addEventListener("resize", refitPanes);

// ---------------------------------------------------------------------------
// Editor (loupe only): non-destructive rotate / flip / crop / border / tone.
// Each photo carries its own history stack (p._hist / p._hidx), so undo/redo
// survive navigating between photos within a session; the current state is
// persisted per-photo. Originals are never written — Reset fully reverts.
// ---------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const editorPhoto = () => (S.editor ? S.byPath.get(S.editor.path) : null);
function curEdits() {
  const p = editorPhoto();
  return p && p._hist ? p._hist[p._hidx] : {};
}

// The editor is ambient in loupe view: the bar is always shown and re-binds to
// whatever photo is current, so navigating keeps editing the right one.
function bindEditor(path) {
  const p = S.byPath.get(path);
  if (!p) return;
  if (S.cropMode) exitCropMode(false);   // no re-render — we're rebinding anyway
  if (!p._hist) { p._hist = [clone(p.edits)]; p._hidx = 0; }
  S.editor = { path, showOrig: false };
  $("editBar").classList.remove("hidden");
  syncEditControls();
  $("gridBtn").classList.toggle("active", S.showGrid);
  syncGridOverlay();
  $("histBtn").classList.toggle("active", S.showHist);
}

// push a new state (dropping any redo branch), persist, re-render
function pushEdit(edits) {
  const p = editorPhoto();
  if (!p) return;
  p._hist = p._hist.slice(0, p._hidx + 1);
  p._hist.push(edits);
  p._hidx = p._hist.length - 1;
  commitEdit();
}
function undoEdit() { const p = editorPhoto(); if (p && p._hist && p._hidx > 0) { p._hidx--; commitEdit(true); } }
function redoEdit() { const p = editorPhoto(); if (p && p._hist && p._hidx < p._hist.length - 1) { p._hidx++; commitEdit(true); } }

async function commitEdit(syncControls) {
  const p = editorPhoto();
  if (!p) return;
  if (S.cropMode) exitCropMode(false);   // edits changed under the overlay — drop it
  if (S.editor.showOrig) { S.editor.showOrig = false; $("origBtn").classList.remove("active"); }
  const edits = curEdits();
  p.edits = (edits && Object.keys(edits).length) ? clone(edits) : null;
  p._ev = (p._ev || 0) + 1;   // bust browser cache for thumb/stored preview
  if (syncControls) syncEditControls();
  renderEditPreview();
  const vi = S.view.indexOf(p);
  if (vi >= 0) refreshCell(vi);
  try {
    await post("/api/edit", { path: p.path, edits: p.edits });
    refreshThumb(p);   // only after the server knows the new edits (avoids a stale fetch)
  } catch (err) { toast("Edit save failed: " + err.message); }
}

// re-fetch a photo's grid thumbnail after its stored edits changed
function refreshThumb(p) {
  const vi = S.view.indexOf(p);
  if (vi < 0) return;
  const img = grid.querySelector(`.cell[data-i="${vi}"] img`);
  if (!img) return;
  if (img.src) img.src = thumbUrl(p.path);
  else img.dataset.src = thumbUrl(p.path);   // not lazily loaded yet
}

// server render of the edits dict into the pane. Live CSS layers (filter,
// border, straighten transform) stay up until the baked image arrives, so
// there's no flash back to the unedited base.
function renderEditPreview(overrideEdits, keepLive) {
  const pane = panesEl.children[0];
  if (!pane || !S.editor) return;
  const img = pane._img;
  const edits = overrideEdits !== undefined ? overrideEdits : curEdits();
  const url = previewUrl(S.editor.path, edits);
  img.onload = () => {
    if (!keepLive) {   // keepLive: a drag is in progress, its live layer stays
      img.style.filter = ""; img.style.border = "";
      if (S.editor) S.editor.liveFine = 0;
      drawHistogram();
    }
    computeFit(0, pane, img); applyTransform(); updateHud();
  };
  if (img.getAttribute("src") === url) {
    if (img.complete && img.naturalWidth) img.onload();
  } else {
    img.src = url;
  }
}

// flip the loupe between the untouched original and the edited version
function toggleOriginal() {
  const p = editorPhoto();
  if (!p) return;
  if (!S.editor.showOrig && !p.edits) { toast("No edits — this is the original"); return; }
  if (S.cropMode) exitCropMode(false);
  S.editor.showOrig = !S.editor.showOrig;
  $("origBtn").classList.toggle("active", S.editor.showOrig);
  renderEditPreview(S.editor.showOrig ? {} : undefined);
  toast(S.editor.showOrig ? "Original" : "Edited", 900);
}

// bake the current edits into a new JPEG next to the original file
async function saveCopy() {
  const p = editorPhoto();
  if (!p) return;
  if (!p.edits) { toast("No edits to save"); return; }
  try {
    const res = await post("/api/save-copy", { path: p.path });
    const np = res.photo;
    np.ext = extOf(np.filename);
    np.edits = null;
    S.photos.push(np);
    S.byPath.set(np.path, np);
    buildGroups();
    populateTypeFilter();
    sortPhotos();
    toast("Saved " + np.filename);
  } catch (e) { toast("Save copy failed: " + e.message, 4000); }
}

function syncEditControls() {
  const e = curEdits();
  $("editBar").querySelectorAll("input[data-edit]").forEach((inp) => {
    const v = e[inp.dataset.edit] != null ? e[inp.dataset.edit] : neutralOf(inp.dataset.edit);
    inp.value = v;
    const num = inp.parentElement.querySelector("input.num");
    if (num) num.value = (+v).toFixed(2);
  });
  $("fineR").value = e.fine || 0;
  $("fineRNum").value = e.fine || 0;
  $("autoBtn").classList.toggle("active", !!e.auto);
  const b = e.border || {};
  $("borderW").value = b.w || 0;
  $("borderWNum").value = Math.round((b.w || 0) * 1000) / 10;
  $("borderC").value = b.color || "#ffffff";
  $("cropBtn").classList.toggle("active", !!e.crop || S.cropMode);
  $("origBtn").classList.toggle("active", !!(S.editor && S.editor.showOrig));
}

function editAction(act) {
  const e = curEdits();
  if (act === "rotL" || act === "rotR") {
    const n = clone(e);
    n.rot = (((n.rot || 0) + (act === "rotR" ? 90 : 270)) % 360);
    delete n.crop;   // crop coords are tied to the old rotation — drop them
    pushEdit(n); return;
  }
  if (act === "flipH" || act === "flipV") {
    const n = clone(e); n[act] = !n[act]; delete n.crop; pushEdit(n); return;
  }
  if (act === "crop") { S.cropMode ? exitCropMode() : enterCropMode(); return; }
  if (act === "grid") return toggleGrid();
  if (act === "hist") return toggleHist();
  if (act === "auto") {
    const n = clone(e);
    if (n.auto) delete n.auto; else n.auto = true;
    pushEdit(n); return;
  }
  if (act === "undo") return undoEdit();
  if (act === "redo") return redoEdit();
  if (act === "reset") return pushEdit({});   // commitEdit clears crop mode
  if (act === "orig") return toggleOriginal();
  if (act === "save") return saveCopy();
  if (act === "presetApply") return applySelectedPreset();
  if (act === "presetSave") return saveCurrentAsPreset();
  if (act === "presetDel") return deleteSelectedPreset();
}

// ---- copy/paste the whole edit stack between photos (Ctrl+C / Ctrl+V) ----
// In the loupe editor: copies/applies to the one photo being edited (undoable).
// In the grid: copies the active cell's edits; paste applies to every photo in
// the compare selection (Space to multi-select), or the active cell if none.
let copiedEdits = null;
function copyEdits() {
  const e = curEdits();
  if (!e || !Object.keys(e).length) { toast("No edits to copy"); return; }
  copiedEdits = clone(e);
  updatePasteBtn();
  toast("Edits copied");
}
function pasteEdits() {
  if (!copiedEdits) { toast("No copied edits — Ctrl+C on an edited photo first"); return; }
  if (JSON.stringify(copiedEdits) === JSON.stringify(curEdits())) { toast("Already applied"); return; }
  pushEdit(clone(copiedEdits));
  toast("Edits pasted");
}

function copyEditsFromGrid() {
  const p = S.view[activeIndex()];
  if (!p || !p.edits) { toast("No edits to copy"); return; }
  copiedEdits = clone(p.edits);
  updatePasteBtn();
  toast("Edits copied — select photos (Space) and Ctrl+V, or paste onto one");
}

// paths to act on for a grid-level apply: the compare selection if any photos
// are selected, else just the currently active cell
function targetSelection() {
  if (S.compare.length) return S.compare.slice();
  const p = S.view[activeIndex()];
  return p ? [p.path] : [];
}

// Write `edits` onto every photo in `targets`, saving each to the server and
// giving each its own one-step undo history entry (so opening one later and
// hitting Ctrl+Z reverts just this apply).
async function applyEditsToSelection(edits, label) {
  if (!edits) { toast("Nothing to apply"); return; }
  const targets = targetSelection();
  if (!targets.length) { toast("No photo selected"); return; }
  for (const path of targets) {
    const p = S.byPath.get(path);
    if (!p) continue;
    if (!p._hist) { p._hist = [clone(p.edits)]; p._hidx = 0; }
    p._hist = p._hist.slice(0, p._hidx + 1);
    p._hist.push(clone(edits));
    p._hidx = p._hist.length - 1;
    p.edits = (edits && Object.keys(edits).length) ? clone(edits) : null;
    p._ev = (p._ev || 0) + 1;
    const vi = S.view.indexOf(p);
    if (vi >= 0) refreshCell(vi);
  }
  const n = targets.length;
  try {
    await Promise.all(targets.map((path) =>
      post("/api/edit", { path, edits: S.byPath.get(path).edits })));
    targets.forEach((path) => refreshThumb(S.byPath.get(path)));
    toast(`Applied ${label} to ${n} photo${n === 1 ? "" : "s"}`);
  } catch (e) { toast("Save failed: " + e.message); }
}

function pasteEditsToSelection() {
  if (!copiedEdits) { toast("No copied edits — Ctrl+C on an edited photo first"); return; }
  applyEditsToSelection(copiedEdits, "edits");
}

function updatePasteBtn() {
  const btn = $("pasteBtn");
  if (!btn) return;
  btn.disabled = !copiedEdits;
  const n = S.compare.length;
  btn.textContent = n ? `📋 Paste edits (${n})` : "📋 Paste edits";
  btn.title = copiedEdits
    ? `Paste copied edits onto ${n ? n + " selected photos" : "the current photo"} (Ctrl+V)`
    : "Copy edits first: open a photo, Ctrl+C";
}

// ---- named presets: save the current edit stack, apply it later — either to
// the photo being edited, or to a whole grid selection. Stored in localStorage
// since they're just reusable templates, not per-photo state. ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function loadPresets() {
  try { return JSON.parse(localStorage.getItem("editPresets") || "[]"); }
  catch (e) { return []; }
}
function savePresets(list) { localStorage.setItem("editPresets", JSON.stringify(list)); }
function presetEdits(name) {
  const found = loadPresets().find((p) => p.name === name);
  return found ? found.edits : null;
}
function populatePresetSelects() {
  const opts = '<option value="">Preset…</option>' +
    loadPresets().map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
  $("presetSel").innerHTML = opts;
  $("presetGridSel").innerHTML = opts.replace("Preset…", "🎛 Preset…");
}
function saveCurrentAsPreset() {
  if (!S.editor) return;
  const e = curEdits();
  if (!e || !Object.keys(e).length) { toast("No edits to save as a preset"); return; }
  const name = (prompt("Preset name:") || "").trim();
  if (!name) return;
  const list = loadPresets().filter((p) => p.name !== name);   // replace same-name
  list.push({ name, edits: clone(e) });
  savePresets(list);
  populatePresetSelects();
  $("presetSel").value = name;
  toast(`Preset "${name}" saved`);
}
function applySelectedPreset() {
  const name = $("presetSel").value;
  if (!name) { toast("Choose a preset first"); return; }
  const edits = presetEdits(name);
  if (!edits) return;
  pushEdit(clone(edits));
  toast(`Applied "${name}"`);
}
function deleteSelectedPreset() {
  const name = $("presetSel").value;
  if (!name) { toast("Choose a preset first"); return; }
  savePresets(loadPresets().filter((p) => p.name !== name));
  populatePresetSelects();
  toast(`Preset "${name}" deleted`);
}
function applyPresetToSelection() {
  const name = $("presetGridSel").value;
  if (!name) { toast("Choose a preset first"); return; }
  const edits = presetEdits(name);
  if (!edits) return;
  applyEditsToSelection(edits, `preset "${name}"`);
  $("presetGridSel").value = "";
}

// ---- fine rotation (straighten): live rotate+zoom while dragging, exact
// server render (auto-cropped to the inscribed rect) on release ----
let fineDragging = false;
function fineInput() {
  $("fineRNum").value = Math.round(parseFloat($("fineR").value) * 10) / 10;
  if (!S.editor) return;
  if (!fineDragging) {
    fineDragging = true;
    syncGridOverlay();   // force the alignment grid on for this drag
    // base for the live transform: current edits minus fine/crop/border —
    // the same frame the server rotates before those steps
    const base = clone(curEdits());
    delete base.fine; delete base.crop; delete base.border;
    renderEditPreview(base, true);
  }
  S.editor.liveFine = parseFloat($("fineR").value) || 0;
  applyTransform();
}
function fineCommit() {
  fineDragging = false;
  syncGridOverlay();   // drop the forced grid if the toggle is off
  if (!S.editor) return;
  const v = Math.round(parseFloat($("fineR").value) * 10) / 10;
  const cur = curEdits();
  if (v === (cur.fine || 0)) { renderEditPreview(); return; }   // unchanged — settle back
  const n = clone(cur);
  if (v) n.fine = v; else delete n.fine;
  delete n.crop;   // crop coords are tied to the old geometry — drop them
  pushEdit(n);
  $("fineR").blur(); $("fineRNum").blur();
}

// ---- border: live CSS border while dragging, server-baked on release ----
let borderDragging = false;
function borderInput() {
  $("borderWNum").value = Math.round(parseFloat($("borderW").value) * 1000) / 10;
  if (!S.editor) return;
  if (!borderDragging) {
    borderDragging = true;
    // drop the baked border so the live CSS border isn't doubled
    const base = clone(curEdits());
    delete base.border;
    renderEditPreview(base, true);
  }
  applyLiveBorder();
}
function applyLiveBorder() {
  const pane = panesEl.children[0];
  const f = S.viewer && S.viewer._fit[0];
  if (!pane || !f) return;
  const w = parseFloat($("borderW").value);
  const px = Math.round(w * Math.min(f.nw, f.nh));
  pane._img.style.border = px > 0 ? `${px}px solid ${$("borderC").value}` : "";
}
function borderCommit() {
  borderDragging = false;
  if (!S.editor) return;
  const w = parseFloat($("borderW").value);
  const cur = curEdits();
  const prev = cur.border || {};
  if (w === (prev.w || 0) && (!w || $("borderC").value === prev.color)) {
    renderEditPreview();   // unchanged — settle back
    return;
  }
  const n = clone(cur);
  if (w > 0) n.border = { w, color: $("borderC").value };
  else delete n.border;
  pushEdit(n);
  $("borderW").blur(); $("borderC").blur();
}

// ---- tonal sliders: live preview while dragging, bake on release ----
// bright/contrast/saturation map to CSS filters; wbR/wbB are an exact
// feColorMatrix (same independent R/B gains as the server); sharpness is an
// feConvolveMatrix built from the same blend PIL uses (identity·v + SMOOTH·(1-v)).
const LIVE_KEYS = ["bright", "contrast", "saturation", "sharpness", "wbR", "wbB"];
const neutralOf = (k) => (k === "wbR" || k === "wbB" ? 0 : 1);
let sliderDragging = false;

function geomEdits() {
  const e = clone(curEdits());
  for (const k of LIVE_KEYS) delete e[k];
  return e;
}
function sliderVal(k) {
  const inp = $("editBar").querySelector(`input[data-edit="${k}"]`);
  return inp ? parseFloat(inp.value) : neutralOf(k);
}
function liveFilter() {
  const parts = [];
  const wr = sliderVal("wbR"), wb = sliderVal("wbB");
  if (wr || wb) {
    $("liveWBMat").setAttribute("values",
      `${1 + 0.3 * wr} 0 0 0 0  0 1 0 0 0  0 0 ${1 + 0.3 * wb} 0 0  0 0 0 1 0`);
    parts.push("url(#liveWB)");
  }
  parts.push(`brightness(${sliderVal("bright")}) contrast(${sliderVal("contrast")}) ` +
             `saturate(${sliderVal("saturation")})`);
  const s = sliderVal("sharpness");
  if (Math.abs(s - 1) > 1e-6) {
    const e = (1 - s) / 13, c = s + 5 * (1 - s) / 13;
    $("liveSharpMat").setAttribute("kernelMatrix",
      `${e} ${e} ${e} ${e} ${c} ${e} ${e} ${e} ${e}`);
    parts.push("url(#liveSharp)");
  }
  return parts.join(" ");
}
function sliderInput(inp) {
  const num = inp.parentElement.querySelector("input.num");
  if (num) num.value = parseFloat(inp.value).toFixed(2);
  const pane = panesEl.children[0];
  if (!pane || !S.editor) return;
  // first move: drop the baked-in tonal layer so the live filter isn't doubled
  if (!sliderDragging) { sliderDragging = true; renderEditPreview(geomEdits(), true); }
  pane._img.style.filter = liveFilter();
}
function sliderCommit(inp) {
  sliderDragging = false;
  const n = clone(curEdits());
  const val = parseFloat(inp.value);
  const key = inp.dataset.edit;
  if (Math.abs(val - neutralOf(key)) < 1e-6) delete n[key]; else n[key] = val;
  pushEdit(n);   // server bakes the real result; live filter stays until it loads
  inp.blur();    // release focus so arrow keys go back to navigation
}

// ---- alignment grid: helper lines over the pane for straightening/composition.
// On by default in edit mode; also force-shown while the straighten slider is
// being dragged (the actual "easier straightening" use case), even if toggled off.
function toggleGrid() {
  S.showGrid = !S.showGrid;
  localStorage.setItem("showGrid", S.showGrid ? "1" : "0");
  $("gridBtn").classList.toggle("active", S.showGrid);
  syncGridOverlay();
}
function syncGridOverlay() {
  const pane = panesEl.children[0];
  if (!pane || !S.viewer || S.viewer.mode !== "loupe") return;
  const show = !!S.editor && (S.showGrid || fineDragging);
  let ov = pane.querySelector(".gridoverlay");
  if (show && !ov) {
    ov = document.createElement("div");
    ov.className = "gridoverlay";
    pane.appendChild(ov);
  } else if (!show && ov) {
    ov.remove();
  }
}

// ---- crop: drag a box on the (un-cropped, un-bordered) rotated frame ----
function enterCropMode() {
  if (!S.editor) return;
  if (S.editor.showOrig) { S.editor.showOrig = false; $("origBtn").classList.remove("active"); }
  S.cropMode = true;
  $("cropBtn").classList.add("active");
  toast("Drag a box to crop · Esc cancels");
  // strip crop AND border: crop coords are normalized against the bare frame,
  // so the overlay must be drawn on that same frame
  const noCrop = clone(curEdits()); delete noCrop.crop; delete noCrop.border;
  const pane = panesEl.children[0];
  const img = pane._img;
  const url = previewUrl(S.editor.path, noCrop);
  const ready = () => {
    computeFit(0, pane, img);
    S.viewer.zoom = 1; S.viewer.panx = 0; S.viewer.pany = 0;
    applyTransform();
    buildCropOverlay(pane);
  };
  img.onload = ready;
  // if the un-cropped frame is already what's displayed, onload won't fire
  if (img.getAttribute("src") === url && img.complete && img.naturalWidth) ready();
  else img.src = url;
}

function exitCropMode(rerender = true) {
  S.cropMode = false;
  $("cropBtn").classList.remove("active");
  const ov = document.getElementById("cropOverlay");
  if (ov) ov.remove();
  // rerender=false when the caller is about to render something else anyway
  // (rebinding to another photo, committing an edit) — re-rendering here would
  // flash the previous photo's preview into the pane
  if (rerender && S.editor) renderEditPreview();
}

function buildCropOverlay(pane) {
  const f = S.viewer._fit[0];
  if (!f) return;
  const old = document.getElementById("cropOverlay");
  if (old) old.remove();
  const ov = document.createElement("div");
  ov.id = "cropOverlay"; ov.className = "cropoverlay";
  const sel = document.createElement("div");
  sel.className = "cropsel hidden";
  ov.appendChild(sel);
  pane.appendChild(ov);

  // displayed image rect inside the pane (zoom 1, no pan)
  const imgW = f.nw * f.fit, imgH = f.nh * f.fit;
  const imgL = (f.PW - imgW) / 2, imgT = (f.PH - imgH) / 2;
  const clampX = (x) => Math.max(imgL, Math.min(imgL + imgW, x));
  const clampY = (y) => Math.max(imgT, Math.min(imgT + imgH, y));

  let drag = false, sx = 0, sy = 0;
  ov.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const r = ov.getBoundingClientRect();
    drag = true; sx = clampX(e.clientX - r.left); sy = clampY(e.clientY - r.top);
    sel.classList.remove("hidden");
    sel.style.left = sx + "px"; sel.style.top = sy + "px";
    sel.style.width = sel.style.height = "0px";
  });
  ov.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const r = ov.getBoundingClientRect();
    const cx = clampX(e.clientX - r.left), cy = clampY(e.clientY - r.top);
    sel.style.left = Math.min(sx, cx) + "px"; sel.style.top = Math.min(sy, cy) + "px";
    sel.style.width = Math.abs(cx - sx) + "px"; sel.style.height = Math.abs(cy - sy) + "px";
  });
  ov.addEventListener("mouseup", (e) => {
    if (!drag) return; drag = false;
    const r = ov.getBoundingClientRect();
    const cx = clampX(e.clientX - r.left), cy = clampY(e.clientY - r.top);
    const x0 = Math.min(sx, cx), y0 = Math.min(sy, cy);
    const x1 = Math.max(sx, cx), y1 = Math.max(sy, cy);
    if (x1 - x0 < 8 || y1 - y0 < 8) { toast("Crop too small"); return; }
    const crop = [(x0 - imgL) / imgW, (y0 - imgT) / imgH,
                  (x1 - imgL) / imgW, (y1 - imgT) / imgH]
                 .map((n) => Math.max(0, Math.min(1, +n.toFixed(4))));
    S.cropMode = false; $("cropBtn").classList.remove("active"); ov.remove();
    const n = clone(curEdits()); n.crop = crop;
    pushEdit(n);
  });
}

// ---------------------------------------------------------------------------
// Date split
// ---------------------------------------------------------------------------
function openSplit() {
  if (!S.folder) { toast("Open a folder first"); return; }
  $("spStatus").textContent = "";
  $("splitModal").classList.remove("hidden");
}
async function runSplit() {
  $("spStatus").textContent = "Working…";
  try {
    const res = await post("/api/split-by-date", {
      granularity: $("spGran").value, source: $("spSrc").value,
      action: $("spAction").value, dest: $("spDest").value.trim() || null,
    });
    const verb = res.action === "copy" ? "Copied" : "Moved";
    let msg = `${verb} ${res.moved} files into date folders under ${res.dest}`;
    if (res.errors.length) msg += `\n${res.errors.length} errors:\n` + res.errors.slice(0, 5).join("\n");
    $("spStatus").textContent = msg;
    toast(`${verb} ${res.moved} files`);
    $("recursive").checked = true;   // sorted files now live in subfolders
    $("splitModal").classList.add("hidden");
    reloadFolder();
  } catch (e) { $("spStatus").textContent = "Error: " + e.message; }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function inField(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
}

document.addEventListener("keydown", (e) => {
  // editor undo/redo — handled first so it works even with a slider focused
  if (S.editor && (e.ctrlKey || e.metaKey)) {
    const kk = e.key.toLowerCase();
    if (kk === "z") { e.preventDefault(); e.shiftKey ? redoEdit() : undoEdit(); return; }
    if (kk === "y") { e.preventDefault(); redoEdit(); return; }
  }
  // Tab hides/shows the whole edit sidebar (Lightroom's "hide panels" shortcut)
  // — handled early so it works even with a slider focused, and takes
  // priority over the browser's default focus-cycling.
  if (S.viewer && S.viewer.mode === "loupe" && e.key === "Tab" &&
      !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  // copy/paste the edit stack — but not while a text field owns Ctrl+C/V.
  // In the loupe editor: acts on the one photo being edited. In the grid:
  // copies the active cell, pastes onto the compare selection (or active cell).
  if ((e.ctrlKey || e.metaKey) && !inField(e)) {
    const kk = e.key.toLowerCase();
    if (S.editor) {
      if (kk === "c") { e.preventDefault(); copyEdits(); return; }
      if (kk === "v") { e.preventDefault(); pasteEdits(); return; }
    } else if (!S.viewer) {
      if (kk === "c") { e.preventDefault(); copyEditsFromGrid(); return; }
      if (kk === "v") { e.preventDefault(); pasteEditsToSelection(); return; }
    }
  }
  // modals
  if (!$("help").classList.contains("hidden") && e.key === "Escape") { $("help").classList.add("hidden"); return; }
  if (!$("splitModal").classList.contains("hidden")) {
    if (e.key === "Escape") $("splitModal").classList.add("hidden");
    return;
  }
  if (!$("deleteModal").classList.contains("hidden")) {
    if (e.key === "Escape") $("deleteModal").classList.add("hidden");
    return;
  }
  if (!$("exportModal").classList.contains("hidden")) {
    if (e.key === "Escape") $("exportModal").classList.add("hidden");
    return;
  }
  if (inField(e)) return;

  const k = e.key.toLowerCase();
  const inViewer = !!S.viewer;

  // ---- marking: keys flanking the ESDF nav cluster, works everywhere ----
  // W keep · R reject · Q clear flag · 1-5 stars · ` 0 stars
  switch (k) {
    case "w": markCurrent({ flag: 1 }, true); return;
    case "r": markCurrent({ flag: -1 }, true); return;
    case "q": markCurrent({ flag: 0 }, false); return;
    case "`": markCurrent({ rating: 0 }, false); return;
    case "u": undoMark(); return;
  }
  // Compare best-pick: in compare view with ≤3 images, S/D/F keep that pane,
  // reject the rest, and close. (Overrides compare nav/zoom for those keys.)
  if (S.viewer && S.viewer.mode === "compare" && S.viewer.paths.length <= 3) {
    const pi = PICK_KEYS.indexOf(k);
    if (pi >= 0 && pi < S.viewer.paths.length) { pickBest(pi); return; }
  }
  if (k >= "1" && k <= "5") { markCurrent({ rating: parseInt(k, 10) }, false); return; }

  if (inViewer) {
    if (S.cropMode) {   // crop drag in progress swallows nav/zoom; Esc cancels it
      if (k === "escape") exitCropMode();
      return;
    }
    if (k === "escape") { closeViewer(); return; }
    // editor shortcuts (loupe only): O original/edited, C crop, I info, G grid, H histogram
    if (S.viewer.mode === "loupe" && S.editor) {
      if (k === "o") { toggleOriginal(); return; }
      if (k === "c") { editAction("crop"); return; }
      if (k === "i") { toggleMeta(); return; }
      if (k === "g") { toggleGrid(); return; }
      if (k === "h") { toggleHist(); return; }
    }
    if (S.viewer.mode === "tournament") {
      switch (k) {
        case "arrowleft": case "s": tournamentVote("left"); return;
        case "arrowright": case "f": tournamentVote("right"); return;
        case "arrowup": case "e": case "+": case "=": zoomAtCenter(1.25); return;
        case "arrowdown": case "d": case "-": case "_": zoomAtCenter(0.8); return;
        case "z": resetZoom(); return;
      }
      return;
    }
    switch (k) {
      case "arrowright": case "f":
        if (S.viewer.mode === "loupe") loupeGo(S.viewer.cur + 1);
        else { S.viewer.cur = Math.min(S.viewer.paths.length - 1, S.viewer.cur + 1); markCurPane(); }
        return;
      case "arrowleft": case "s":
        if (S.viewer.mode === "loupe") loupeGo(S.viewer.cur - 1);
        else { S.viewer.cur = Math.max(0, S.viewer.cur - 1); markCurPane(); }
        return;
      case "arrowup": case "e": case "+": case "=": zoomAtCenter(1.25); return;
      case "arrowdown": case "d": case "-": case "_": zoomAtCenter(0.8); return;
      case "z": resetZoom(); return;
    }
    return;
  }

  // ---- grid: ESDF navigation (arrows still work) ----
  const cols = columns();
  switch (k) {
    case "arrowright": case "f": setCursor(S.cursor + 1); e.preventDefault(); return;
    case "arrowleft": case "s": setCursor(S.cursor - 1); e.preventDefault(); return;
    case "arrowdown": case "d": setCursor(S.cursor + cols); e.preventDefault(); return;
    case "arrowup": case "e": setCursor(S.cursor - cols); e.preventDefault(); return;
    case "home": setCursor(0); return;
    case "end": setCursor(S.view.length - 1); return;
    case "enter": case "g": openLoupe(activeIndex()); return;
    case " ": {
      const idx = activeIndex();
      const p = S.view[idx];
      if (p) toggleCompare(p.path);
      if (!S.mouseMode) setCursor(idx + 1, true);
      e.preventDefault(); return;
    }
    case "c": openCompare(); return;
    case "x": clearCompare("Compare cleared"); return;
    case "t": cycleFilter(); return;
    case "b": toggleMouseMode(); return;
    case "v": case "?": $("help").classList.remove("hidden"); return;
  }
});

function zoomAtCenter(factor) {
  const pane = panesEl.children[S.viewer.mode === "loupe" ? 0 : Math.max(0, S.viewer.cur)];
  if (!pane) return;
  const r = pane.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}

function cycleFilter() {
  const opts = ["all", "keep", "reject", "unflagged", "rated1", "rated3", "rated5"];
  const i = (opts.indexOf(S.filter) + 1) % opts.length;
  S.filter = opts[i];
  $("filterSel").value = S.filter;
  applyFilter();
  toast("Filter: " + S.filter);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
async function runExport() {
  const dest = $("exDest").value.trim();
  if (!dest) { $("exStatus").textContent = "Enter a destination folder."; return; }
  $("exStatus").textContent = "Exporting…";
  $("exFiles").classList.add("hidden");
  try {
    const res = await post("/api/export", {
      dest,
      action: $("exAction").value,
      selection: $("exSel").value,
      min_rating: parseInt($("exMin").value, 10),
      keep_structure: $("exStruct").checked,
      compress: $("exCompress").checked,
      quality: parseInt($("exQuality").value, 10),
    });
    const verb = res.action === "move" ? "Moved" : "Copied";
    let msg = `${verb} ${res.exported} files to ${res.dest}`;
    if (res.errors.length) msg += ` · ${res.errors.length} errors`;
    $("exStatus").textContent = msg;
    renderExFiles(verb, res.files, res.errors);
    toast(`${verb} ${res.exported} files`);
    reloadFolder();  // rescan disk: reflects moved-out files and any copies in-tree
  } catch (e) { $("exStatus").textContent = "Error: " + e.message; }
}

// list exactly which files landed (and any per-file errors)
function renderExFiles(verb, files, errors) {
  const el = $("exFiles");
  files = files || []; errors = errors || [];
  if (!files.length && !errors.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  let h = `<div class="exhead">${verb} ${files.length} file${files.length === 1 ? "" : "s"}:</div>`;
  h += files.map((f) =>
    `<div class="exrow"><span class="exname">${f.name}</span>` +
    (f.compressed ? `<span class="excomp">compressed</span>` : "") +
    `<span class="expath" title="${f.dest}">${f.dest}</span></div>`).join("");
  if (errors.length) h += errors.map((e) => `<div class="exrow err">⚠ ${e}</div>`).join("");
  el.innerHTML = h;
  el.classList.remove("hidden");
}

function rejectedCount() { return visiblePhotos().filter((p) => p.flag === -1).length; }

function defaultExportDest() {
  if (!S.folder) return "";
  const sep = S.folder.includes("\\") ? "\\" : "/";
  return S.folder.replace(/[\\/]+$/, "") + sep + "cull_output";
}

function openExport() {
  if (!$("exDest").value.trim()) $("exDest").value = defaultExportDest();
  const n = rejectedCount();
  const btn = $("delRejected");
  btn.textContent = `🗑 Delete rejected (${n})`;
  btn.disabled = n === 0;
  $("delInfo").textContent = S.haveTrash
    ? "Move all rejected (X) photos to the Recycle Bin (recoverable)."
    : "Permanently remove all rejected (X) photos from disk (NOT recoverable).";
  $("exStatus").textContent = "";
  $("exFiles").classList.add("hidden");
  $("exFiles").innerHTML = "";
  $("exportModal").classList.remove("hidden");
}

// Set of paths currently checked for deletion in the delete modal.
let delSelected = new Set();

function openDeleteModal() {
  const rejected = visiblePhotos().filter((p) => p.flag === -1);
  if (!rejected.length) { toast("No rejected photos"); return; }
  delSelected = new Set(rejected.map((p) => p.path));

  const where = S.haveTrash
    ? "moved to the <b>Recycle Bin</b> (recoverable)"
    : "<b>permanently deleted</b> from disk (NOT recoverable)";
  $("delModalInfo").innerHTML =
    `The photos below will be ${where}. Click any thumbnail to <b>deselect</b> ` +
    `(keep) it — only the highlighted ones get deleted. ` +
    `RAW+JPEG groups are deleted together.`;

  const g = $("delGrid");
  g.innerHTML = "";
  const frag = document.createDocumentFragment();
  rejected.forEach((p) => {
    const cell = document.createElement("div");
    cell.className = "del-cell selected";
    cell.dataset.path = p.path;
    cell.innerHTML =
      `<img loading="lazy" src="${thumbUrl(p.path)}" alt="" />` +
      `<div class="del-check">🗑</div>` +
      typeBadge(p) +
      `<div class="del-name">${p.filename}</div>`;
    cell.addEventListener("click", () => toggleDelSelect(p.path, cell));
    frag.appendChild(cell);
  });
  g.appendChild(frag);

  updateDelCount();
  $("delStatus").textContent = "";
  $("exportModal").classList.add("hidden");
  $("deleteModal").classList.remove("hidden");
}

function toggleDelSelect(path, cell) {
  if (delSelected.has(path)) { delSelected.delete(path); cell.classList.remove("selected"); }
  else { delSelected.add(path); cell.classList.add("selected"); }
  updateDelCount();
}

function delSetAll(on) {
  $("delGrid").querySelectorAll(".del-cell").forEach((c) => {
    const path = c.dataset.path;
    if (on) { delSelected.add(path); c.classList.add("selected"); }
    else { delSelected.delete(path); c.classList.remove("selected"); }
  });
  updateDelCount();
}

function updateDelCount() {
  const n = delSelected.size;
  $("delSelCount").textContent = `${n} selected for deletion`;
  const btn = $("delConfirm");
  btn.disabled = n === 0;
  btn.textContent = `🗑 Delete ${n} selected`;
}

async function confirmDelete() {
  const items = [...delSelected];
  if (!items.length) return;
  // expand grouped items so every member file (RAW + JPEG) is deleted
  const paths = [];
  items.forEach((pp) => {
    const p = S.byPath.get(pp);
    const mem = (p && p.members && p.members.length) ? p.members : [pp];
    mem.forEach((m) => { if (!paths.includes(m)) paths.push(m); });
  });
  $("delStatus").textContent = "Deleting…";
  try {
    const res = await post("/api/delete-rejected",
      { confirm: true, expected_count: paths.length, paths });
    let msg = `Deleted ${res.deleted} file${res.deleted === 1 ? "" : "s"} (${res.method.replace("_", " ")}).`;
    if (res.errors.length) msg += `\n${res.errors.length} errors:\n` + res.errors.slice(0, 5).join("\n");
    toast(`Deleted ${res.deleted} rejected`);
    $("deleteModal").classList.add("hidden");
    $("exStatus").textContent = msg;
    reloadFolder();  // refresh library
  } catch (e) {
    $("delStatus").textContent = "Error: " + e.message;
    if (/count changed/.test(e.message)) { $("deleteModal").classList.add("hidden"); reloadFolder(); }
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
$("browseBtn").addEventListener("click", browseFolder);
$("reloadBtn").addEventListener("click", reloadFolder);
$("delRejected").addEventListener("click", openDeleteModal);
$("delCancel").addEventListener("click", () => $("deleteModal").classList.add("hidden"));
$("delConfirm").addEventListener("click", confirmDelete);
$("delSelectAll").addEventListener("click", () => delSetAll(true));
$("delSelectNone").addEventListener("click", () => delSetAll(false));
$("exBrowse").addEventListener("click", async () => {
  const folder = await pickFolder();
  if (folder) $("exDest").value = folder;
});
$("helpBtn").addEventListener("click", () => $("help").classList.remove("hidden"));
$("mouseBtn").addEventListener("click", () => toggleMouseMode());
$("helpClose").addEventListener("click", () => $("help").classList.add("hidden"));
$("filterSel").addEventListener("change", (e) => { S.filter = e.target.value; applyFilter(); });
$("typeSel").addEventListener("change", (e) => { S.typeFilter = e.target.value; applyFilter(); });
$("sortSel").addEventListener("change", (e) => { S.sortKey = e.target.value; sortPhotos(); });
$("sortDir").addEventListener("click", () => {
  S.sortDir = -S.sortDir;
  $("sortDir").textContent = S.sortDir === 1 ? "↑" : "↓";
  sortPhotos();
});
$("groupRaw").addEventListener("change", (e) => {
  S.groupRaw = e.target.checked;
  localStorage.setItem("groupRaw", S.groupRaw ? "1" : "0");
  buildGroups();
  applyFilter();
});
$("exportBtn").addEventListener("click", openExport);
$("exCancel").addEventListener("click", () => $("exportModal").classList.add("hidden"));
$("exRun").addEventListener("click", runExport);
$("exCompress").addEventListener("change", (e) => {
  document.querySelector(".exq").classList.toggle("hidden", !e.target.checked);
});

// ---- editor ----
$("editBar").addEventListener("click", (e) => {
  const head = e.target.closest(".ed-sec-head");
  if (head) { toggleSection(head.closest(".ed-section")); return; }
  const b = e.target.closest("button[data-act]");
  if (b) editAction(b.dataset.act);
});
$("sidebarToggle").addEventListener("click", toggleSidebar);
$("editBar").querySelectorAll("input[data-edit]").forEach((inp) => {
  inp.addEventListener("input", () => sliderInput(inp));
  inp.addEventListener("change", () => sliderCommit(inp));
  inp.addEventListener("dblclick", () => { inp.value = 1; sliderCommit(inp); });
});
// numeric twin of each tonal slider: type an exact value, Enter/blur commits
$("editBar").querySelectorAll("input.num[data-num]").forEach((num) => {
  num.addEventListener("change", () => {
    const range = $("editBar").querySelector(`input[data-edit="${num.dataset.num}"]`);
    if (!range || !S.editor) return;
    let v = parseFloat(num.value);
    if (isNaN(v)) v = neutralOf(num.dataset.num);
    v = Math.max(+range.min, Math.min(+range.max, v));
    num.value = v.toFixed(2);
    range.value = v;
    sliderCommit(range);
    num.blur();
  });
});
// fine rotation: live rotate while dragging, exact render on release
$("fineR").addEventListener("input", fineInput);
$("fineR").addEventListener("change", fineCommit);
$("fineR").addEventListener("dblclick", () => { $("fineR").value = 0; fineCommit(); });
$("fineRNum").addEventListener("change", () => {
  let v = parseFloat($("fineRNum").value);
  if (isNaN(v)) v = 0;
  v = Math.max(-45, Math.min(45, Math.round(v * 10) / 10));
  $("fineRNum").value = v;
  $("fineR").value = v;
  fineCommit();
});
// border: live CSS border while dragging (width or color), baked on release
$("borderW").addEventListener("input", borderInput);
$("borderW").addEventListener("change", borderCommit);
$("borderW").addEventListener("dblclick", () => { $("borderW").value = 0; borderCommit(); });
$("borderWNum").addEventListener("change", () => {
  let v = parseFloat($("borderWNum").value);
  if (isNaN(v)) v = 0;
  v = Math.max(0, Math.min(15, v));
  $("borderWNum").value = v;
  $("borderW").value = v / 100;
  borderCommit();
  $("borderWNum").blur();
});
$("borderC").addEventListener("input", borderInput);
$("borderC").addEventListener("change", borderCommit);

// ---- grid-view: paste edits to the compare selection, apply a preset ----
$("pasteBtn").addEventListener("click", pasteEditsToSelection);
$("presetGridApply").addEventListener("click", applyPresetToSelection);
populatePresetSelects();
updatePasteBtn();

// ---- date split ----
$("splitBtn").addEventListener("click", openSplit);
$("spCancel").addEventListener("click", () => $("splitModal").classList.add("hidden"));
$("spRun").addEventListener("click", runSplit);
$("spBrowse").addEventListener("click", async () => {
  const folder = await pickFolder();
  if (folder) $("spDest").value = folder;
});

// ---- grid / thumbnail size slider (persisted) ----
function applyGridSize(px) {
  document.documentElement.style.setProperty("--cell", px + "px");
}
(function initGridSize() {
  const slider = $("gridSize");
  const saved = parseInt(localStorage.getItem("gridSize") || "", 10);
  if (saved >= +slider.min && saved <= +slider.max) slider.value = saved;
  applyGridSize(slider.value);
  slider.addEventListener("input", () => {
    applyGridSize(slider.value);
    localStorage.setItem("gridSize", slider.value);
  });
})();

// ---- RAW+JPEG grouping (persisted) ----
(function initGroupRaw() {
  const saved = localStorage.getItem("groupRaw");
  if (saved !== null) S.groupRaw = saved === "1";
  $("groupRaw").checked = S.groupRaw;
})();

// ---- EXIF panel / alignment grid: on by default, persisted once toggled ----
(function initTogglePrefs() {
  const sm = localStorage.getItem("showMeta");
  if (sm !== null) S.showMeta = sm === "1";
  const sg = localStorage.getItem("showGrid");
  if (sg !== null) S.showGrid = sg === "1";
  const sh = localStorage.getItem("showHist");
  if (sh !== null) S.showHist = sh === "1";
})();

// ---- slider tick marks: dense, evenly-spaced stops so dragging reads as a
// row of small discrete positions rather than a smooth blur. Generated from
// each slider's own range rather than hand-written, so they can't drift out
// of sync — the actual step size (drag/arrow-key precision) is unchanged,
// this only adds visual ticks. Exact values still go through the numeric
// field next to each slider.
//
// Ticks are drawn in CSS (`.ticked`, styles.css) rather than relying on the
// native <datalist> — Chrome doesn't render tick marks for a range input's
// linked datalist at all, so that alone would be invisible for most users.
// The datalist is still populated too, for browsers (Firefox) that do use it
// for keyboard-snap hinting. ----
function fillTicks(datalistId, min, max, count) {
  const dl = document.getElementById(datalistId);
  if (!dl) return;
  dl.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const v = min + (max - min) * (i / (count - 1));
    const opt = document.createElement("option");
    opt.value = String(Math.round(v * 1000) / 1000);
    dl.appendChild(opt);
  }
  document.querySelectorAll(`input[list="${datalistId}"]`).forEach((inp) => {
    inp.classList.add("ticked");
    inp.style.setProperty("--ticks", count - 1);
  });
}
(function initTicks() {
  fillTicks("ticksMid", 0.2, 2, 10);
  fillTicks("ticksSat", 0, 2, 11);
  fillTicks("ticksSharp", 0, 3, 13);
  fillTicks("ticksBorder", 0, 0.15, 16);
  fillTicks("ticksFine", -45, 45, 19);
  fillTicks("ticksTemp", -1, 1, 11);
})();

// ---- collapsible sidebar sections (click a header), persisted per-section ----
function toggleSection(sec) {
  if (!sec) return;
  const collapsed = sec.classList.toggle("collapsed");
  if (sec.dataset.sec) localStorage.setItem("edsec_" + sec.dataset.sec, collapsed ? "1" : "0");
}
(function initSectionCollapse() {
  document.querySelectorAll("#editBar .ed-section[data-sec]").forEach((sec) => {
    if (localStorage.getItem("edsec_" + sec.dataset.sec) === "1") sec.classList.add("collapsed");
  });
})();

// ---- whole-sidebar collapse (Tab, or the ◂ tab) — Lightroom's "hide panels"
// shortcut. Transient (not persisted): it's a "let me see the photo" toggle,
// not a permanent preference, so it always starts expanded on re-entry. ----
function refitPanes() {
  if (!S.viewer) return;
  [...panesEl.children].forEach((pane) => computeFit(+pane.dataset.idx, pane, pane._img));
  applyTransform();
}
function toggleSidebar() {
  S.sidebarCollapsed = !S.sidebarCollapsed;
  $("editBar").classList.toggle("collapsed-full", S.sidebarCollapsed);
  refitPanes();   // sidebar width just changed the pane's space; no image reload triggers this otherwise
}

restore();
