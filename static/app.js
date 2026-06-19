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

const thumbUrl = (p) => "/api/thumb?path=" + encodeURIComponent(p);
const previewUrl = (p) => "/api/preview?path=" + encodeURIComponent(p);

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
  $("counts").innerHTML =
    `<b>${vis.length}</b> photos · <b style="color:var(--keep)">${keep}</b> keep · ` +
    `<b style="color:var(--reject)">${reject}</b> reject · <b>${rated}</b> rated` +
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
async function mark(path, fields) {
  const p = S.byPath.get(path);
  if (!p) return;
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
  if (msg) toast(msg);
}

// Finish a comparison: keep `winner`, reject everyone else in `contenders`,
// clear the compare set, close the viewer.
function finishCompare(winner, contenders) {
  contenders.forEach((path) => mark(path, { flag: path === winner ? 1 : -1 }));
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
    img.onload = () => { computeFit(idx, pane, img); applyTransform(); };
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
  renderViewerMeta();
}

function computeFit(idx, pane, img) {
  const PW = pane.clientWidth, PH = pane.clientHeight;
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return;
  S.viewer._fit[idx] = { fit: Math.min(PW / nw, PH / nh), nw, nh, PW, PH };
}

function applyTransform() {
  const v = S.viewer;
  if (!v) return;
  for (const pane of panesEl.children) {
    const idx = +pane.dataset.idx;
    const f = v._fit[idx];
    const img = pane._img;
    if (!f) continue;
    const scale = f.fit * v.zoom;
    const cx = f.PW / 2 + v.panx;
    const cy = f.PH / 2 + v.pany;
    const left = cx - (f.nw / 2) * scale;
    const top = cy - (f.nh / 2) * scale;
    img.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
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

function attachPaneHandlers(pane, idx) {
  pane.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (S.viewer.mode === "compare") S.viewer.cur = idx;
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(e.clientX, e.clientY, factor);
    markCurPane();
  }, { passive: false });

  let dragging = false, lx = 0, ly = 0;
  pane.addEventListener("mousedown", (e) => {
    if (S.viewer.mode === "compare") { S.viewer.cur = idx; markCurPane(); }
    dragging = true; lx = e.clientX; ly = e.clientY;
    pane.classList.add("grabbing");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    S.viewer.panx += e.clientX - lx;
    S.viewer.pany += e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    applyTransform();
  });
  window.addEventListener("mouseup", () => { dragging = false; pane.classList.remove("grabbing"); });
  pane.addEventListener("dblclick", () => resetZoom());
}

function markCurPane() {
  if (S.viewer.mode !== "compare") return;
  [...panesEl.children].forEach((p) => p.classList.toggle("cur", +p.dataset.idx === S.viewer.cur));
  renderViewerMeta();
}

function loupeGo(i) {
  const v = S.viewer;
  v.cur = Math.max(0, Math.min(v.paths.length - 1, i));
  // reset zoom/pan up front so the next frame is never inherited from the last
  v.zoom = 1; v.panx = 0; v.pany = 0;
  const pane = panesEl.children[0];
  const img = pane._img;
  const url = previewUrl(v.paths[v.cur]);
  img.onload = () => { computeFit(0, pane, img); applyTransform(); updateHud(); };
  if (img.getAttribute("src") !== url) img.src = url;
  // if it's already cached/complete, onload may not fire — fit now
  if (img.complete && img.naturalWidth) computeFit(0, pane, img);
  applyTransform();
  updateHud();
  // keep grid cursor in sync
  const gi = S.view.findIndex((p) => p.path === v.paths[v.cur]);
  if (gi >= 0) setCursor(gi, true);
  renderViewerMeta();
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
  viewer.classList.add("hidden");
  panesEl.innerHTML = "";
}

window.addEventListener("resize", () => {
  if (!S.viewer) return;
  [...panesEl.children].forEach((pane) => computeFit(+pane.dataset.idx, pane, pane._img));
  applyTransform();
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function inField(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
}

document.addEventListener("keydown", (e) => {
  // modals
  if (!$("help").classList.contains("hidden") && e.key === "Escape") { $("help").classList.add("hidden"); return; }
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
  }
  // Compare best-pick: in compare view with ≤3 images, S/D/F keep that pane,
  // reject the rest, and close. (Overrides compare nav/zoom for those keys.)
  if (S.viewer && S.viewer.mode === "compare" && S.viewer.paths.length <= 3) {
    const pi = PICK_KEYS.indexOf(k);
    if (pi >= 0 && pi < S.viewer.paths.length) { pickBest(pi); return; }
  }
  if (k >= "1" && k <= "5") { markCurrent({ rating: parseInt(k, 10) }, false); return; }

  if (inViewer) {
    if (k === "escape") { closeViewer(); return; }
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
  try {
    const res = await post("/api/export", {
      dest,
      action: $("exAction").value,
      selection: $("exSel").value,
      min_rating: parseInt($("exMin").value, 10),
      keep_structure: $("exStruct").checked,
    });
    let msg = `Exported ${res.exported} files to ${res.dest}`;
    if (res.errors.length) msg += `\n${res.errors.length} errors:\n` + res.errors.slice(0, 5).join("\n");
    $("exStatus").textContent = msg;
    toast(`Exported ${res.exported} files`);
    reloadFolder();  // rescan disk: reflects moved-out files and any copies in-tree
  } catch (e) { $("exStatus").textContent = "Error: " + e.message; }
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

restore();
