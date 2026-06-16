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
  sortDir: 1,          // 1 asc, -1 desc
  compare: [],         // ordered list of paths in the compare set
  viewer: null,        // null | {mode:'loupe'|'compare', paths:[], cur:int, zoom, panx, pany}
  folder: null,        // currently open folder
  haveTrash: false,    // server can send to recycle bin
  mouseMode: false,    // hotkeys act on the hovered photo
  hover: null,         // hovered grid index (mouse mode)
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
  S.photos = photos;
  S.byPath = new Map();
  for (const p of photos) {
    p.ext = extOf(p.filename);
    S.byPath.set(p.path, p);
  }
  populateTypeFilter();
  sortPhotos();   // also calls applyFilter()
}

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

async function browseFolder() {
  try {
    const res = await api("/api/pick-folder");
    if (res.folder) scanFolder(res.folder);
  } catch (e) { toast("Folder picker failed: " + e.message, 4000); }
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
  if (t === "raw" || t === "heic" || t === "std") return typeGroup(p.ext) === t;
  return p.ext === t;  // exact extension
}
function matches(p) {
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
  for (const p of S.photos) {
    if (p.flag === 1) keep++;
    else if (p.flag === -1) reject++;
    if (p.rating > 0) rated++;
  }
  $("counts").innerHTML =
    `<b>${S.photos.length}</b> photos · <b style="color:var(--keep)">${keep}</b> keep · ` +
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
  if (fields.flag !== undefined) p.flag = fields.flag;
  if (fields.rating !== undefined) p.rating = fields.rating;
  // reflect in UI immediately
  const vi = S.view.indexOf(p);
  if (vi >= 0) refreshCell(vi);
  if (S.viewer) renderViewerMeta();
  updateCounts();
  try { await post("/api/mark", { path, flag: fields.flag, rating: fields.rating }); }
  catch (e) { toast("Save failed: " + e.message); }
}

// In the grid, hotkeys act on the hovered cell when mouse mode is on,
// otherwise on the keyboard cursor.
function activeIndex() {
  if (!S.viewer && S.mouseMode && S.hover != null) return S.hover;
  return S.cursor;
}

function currentPhoto() {
  if (S.viewer) return S.byPath.get(S.viewer.paths[S.viewer.cur]);
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
  else { if (S.compare.length >= 6) { toast("Compare max 6"); return; } S.compare.push(path); }
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

function openCompare() {
  let paths = S.compare.slice();
  if (paths.length < 2) {
    // fall back to current + next few
    const start = S.cursor;
    paths = S.view.slice(start, start + 2).map((p) => p.path);
  }
  if (paths.length < 1) return;
  S.viewer = { mode: "compare", paths, cur: 0, zoom: 1, panx: 0, pany: 0 };
  buildPanes();
}

function buildPanes() {
  viewer.classList.remove("hidden");
  panesEl.innerHTML = "";
  const list = S.viewer.mode === "loupe" ? [S.viewer.paths[S.viewer.cur]] : S.viewer.paths;
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
  const list = v.mode === "loupe" ? [v.paths[v.cur]] : v.paths;
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
  if (k >= "1" && k <= "5") { markCurrent({ rating: parseInt(k, 10) }, false); return; }

  if (inViewer) {
    if (k === "escape") { closeViewer(); return; }
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
    case "x": S.compare = []; applyFilter(); toast("Compare cleared"); return;
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
    if ($("exAction").value === "move") restore();  // refresh since files moved
  } catch (e) { $("exStatus").textContent = "Error: " + e.message; }
}

function rejectedCount() { return S.photos.filter((p) => p.flag === -1).length; }

function openExport() {
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

async function deleteRejected() {
  const n = rejectedCount();
  if (!n) return;
  const where = S.haveTrash ? "the Recycle Bin" : "PERMANENTLY DELETED from disk";

  // Warning 1
  if (!confirm(`Delete ${n} rejected photo${n > 1 ? "s" : ""}?\n\nThey will be sent to ${where}.`))
    return;
  // Warning 2 — make them acknowledge the consequence explicitly
  if (!S.haveTrash) {
    if (!confirm(`⚠ This CANNOT be undone — ${n} file${n > 1 ? "s" : ""} will be erased.\n\nProceed?`))
      return;
  } else {
    if (!confirm(`Are you sure? ${n} file${n > 1 ? "s" : ""} will be removed from your library.`))
      return;
  }

  $("exStatus").textContent = "Deleting…";
  try {
    const res = await post("/api/delete-rejected", { confirm: true, expected_count: n });
    let msg = `Deleted ${res.deleted} file${res.deleted === 1 ? "" : "s"} (${res.method.replace("_", " ")}).`;
    if (res.errors.length) msg += `\n${res.errors.length} errors:\n` + res.errors.slice(0, 5).join("\n");
    $("exStatus").textContent = msg;
    toast(`Deleted ${res.deleted} rejected`);
    reloadFolder();  // refresh library
  } catch (e) {
    $("exStatus").textContent = "Error: " + e.message;
    if (/count changed/.test(e.message)) reloadFolder();
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
$("browseBtn").addEventListener("click", browseFolder);
$("reloadBtn").addEventListener("click", reloadFolder);
$("delRejected").addEventListener("click", deleteRejected);
$("exBrowse").addEventListener("click", async () => {
  try {
    const res = await api("/api/pick-folder");
    if (res.folder) $("exDest").value = res.folder;
  } catch (e) { toast("Folder picker failed: " + e.message, 4000); }
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
$("exportBtn").addEventListener("click", openExport);
$("exCancel").addEventListener("click", () => $("exportModal").classList.add("hidden"));
$("exRun").addEventListener("click", runExport);

restore();
