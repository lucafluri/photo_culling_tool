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
  search: "",          // filename substring, case-insensitive
  sortKey: "name",     // name | taken | mtime | size | rating
  sortDir: -1,         // 1 asc, -1 desc (default: filename descending = newest first)
  compare: [],         // ordered list of paths in the compare set
  viewer: null,        // null | {mode:'loupe'|'compare', paths:[], cur:int, zoom, panx, pany}
  folder: null,        // currently open folder
  haveTrash: false,    // server can send to recycle bin
  mouseMode: true,     // hotkeys act on the hovered photo
  hover: null,         // hovered grid index (mouse mode)
  groupRaw: true,      // combine same-named RAW + JPEG into one item
  editor: null,        // null | {path, showOrig} — active loupe editor
  cropMode: false,     // drawing a crop box
  spotMode: false,     // placing retouch spots
  showMeta: true,      // EXIF info panel visible in loupe (default on)
  showGrid: true,      // alignment grid overlay in edit mode (default on)
  showHist: true,      // RGB histogram panel visible in loupe (default on)
  previewSrc: "jpeg",  // for a RAW+JPEG pair: which file the loupe renders
  fillThumbs: false,   // grid thumbnails crop to the cell instead of letterboxing
  showStrip: true,     // filmstrip under the loupe
};

// Remembered across sessions: whether the loupe shows the camera JPEG (instant,
// the camera's own colour) or the negative decoded the way an export would.
(function initPreviewSrc() {
  const saved = localStorage.getItem("previewSrc");
  if (saved === "jpeg" || saved === "raw") S.previewSrc = saved;
})();

const $ = (id) => document.getElementById(id);

// Filenames, EXIF strings and export paths all end up inside innerHTML and all
// come from disk — a file called `a<b>&c.jpg` must not become markup.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Stroke coordinates are normalized 0..1, so five decimals is a twentieth of a
// pixel on a 45MP frame — far finer than anything the brush can resolve. Full
// double precision would spend eighteen characters a number, and the whole edit
// stack travels in the live-preview query string, which the server cuts off at
// 64 KB; rounding is what keeps a heavily retouched photo inside that.
const rnd5 = (v) => Math.round(v * 1e5) / 1e5;

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
// In RAW mode the thumbnail decodes the negative too (`full`): the embedded
// preview is a camera JPEG, so without this the grid keeps showing the film
// simulation while the loupe shows the libraw render. Cost is one demosaic per
// file — the preview-size base is cached on disk and shared with the loupe.
const thumbUrl = (p) => {
  const raw = rawRenderPath(S.byPath.get(p));
  const t = raw || p;
  return "/api/thumb?path=" + encodeURIComponent(t) + (raw ? "&full=1" : "") + verSuffix(t);
};
// The RAW file behind a photo, if it has one — either its own path or the
// negative sitting beside the JPEG it is grouped with.
function rawMemberPath(p) {
  if (!p) return null;
  const paths = (p.members && p.members.length) ? p.members : [p.path];
  return paths.find((tp) => {
    const m = S.byPath.get(tp);
    return m && RAW_EXTS.has(m.ext);
  }) || null;
}

// Which file we should actually render for a photo, or null for "the photo
// itself". Previewing the camera JPEG shows the camera's film simulation and
// tone curve; an export rendered from the negative goes through libraw and looks
// different, so the two are a deliberate choice rather than an accident — and
// the choice holds everywhere the photo is drawn, grid and panes included.
function rawRenderPath(p) {
  if (S.previewSrc !== "raw") return null;
  return rawMemberPath(p);
}

// A render can fail: a truncated file, or a RAW this libraw build can't read.
// In RAW view that is recoverable — the camera JPEG is right there — so drop
// back to it and say why, rather than leaving a broken frame and a mode that
// will fail again on the next photo.
function previewFailed(path) {
  if (S.previewSrc === "raw" && rawMemberPath(S.byPath.get(path))) {
    toast("Could not decode the negative — showing the camera JPEG", 3600);
    setPreviewSrc("jpeg");
    return;
  }
  toast("Preview failed to render", 2400);
}

function setPreviewSrc(which) {
  if (S.previewSrc === which) return;
  S.previewSrc = which;
  localStorage.setItem("previewSrc", which);
  syncSourceRow();
  if (S.editor) renderEditPreview();
  if (S.showMeta) renderMeta();
  refreshThumbs();
}

// the switch only means anything for a photo that has a negative behind it
function syncSourceRow() {
  const row = $("srcRow");
  if (!row) return;
  const raw = rawMemberPath(editorPhoto());
  row.classList.toggle("hidden", !raw);
  $("srcJpegBtn").classList.toggle("active", S.previewSrc !== "raw");
  $("srcRawBtn").classList.toggle("active", S.previewSrc === "raw");
}

// Pass `editsObj` to render a live editor preview of those exact edits; omit it
// to show the photo's stored edits.
function previewUrl(p, editsObj) {
  const raw = rawRenderPath(S.byPath.get(p));
  const target = raw || p;
  let u = "/api/preview?path=" + encodeURIComponent(target);
  if (raw) u += "&full=1";   // decode the negative, don't lift its preview
  if (editsObj !== undefined) u += "&edits=" + encodeURIComponent(JSON.stringify(editsObj || {}));
  else u += verSuffix(target);
  return u;
}

// ---------------------------------------------------------------------------
// Modals — only one is ever open, and whichever it is owns the keyboard.
// ---------------------------------------------------------------------------
const MODALS = ["help", "exportModal", "deleteModal", "splitModal"];
const showModal = (id) => $(id).classList.remove("hidden");
const hideModal = (id) => $(id).classList.add("hidden");
const openModal = () => MODALS.find((id) => !$(id).classList.contains("hidden"));

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastT = null;
function toast(msg, ms = 1600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  // two frames: the element has to be laid out un-shown before `show` can
  // transition it, or the browser collapses both into one paint
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("show")));
  clearTimeout(toastT);
  toastT = setTimeout(() => {
    t.classList.remove("show");
    toastT = setTimeout(() => t.classList.add("hidden"), 200);
  }, ms);
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
  // a fresh folder load starts with no carried-over compare selection, and no
  // mark-undo history pointing at the previous folder's photos
  S.compare = [];
  markHist.length = 0;
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

  const drift = [];        // members whose stored mark disagrees with the group
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
    const wasFlag = primary.flag, wasRating = primary.rating;
    primary.rating = Math.max(...members.map((m) => m.rating || 0));
    const rej = members.find((m) => m.flag === -1);
    const keep = members.find((m) => m.flag === 1);
    primary.flag = wasFlag || (rej ? -1 : keep ? 1 : 0);
    // the primary carries the reconciled mark too, and it is just as likely to
    // be the one that moved — a RAW rejected in an earlier session pulls the
    // JPEG fronting it along
    if (primary.flag !== wasFlag || primary.rating !== wasRating) drift.push(primary);
    for (let i = 1; i < members.length; i++) {
      members[i]._hidden = true;
      // Members can genuinely disagree: a folder culled before grouping was
      // switched on, or a RAW marked in another session. The cell shows one
      // reconciled mark, so the files behind it have to carry it too —
      // otherwise "delete rejected" expands the group, finds only half of it
      // flagged, and refuses the whole batch with a count mismatch.
      if (members[i].flag !== primary.flag || members[i].rating !== primary.rating) {
        members[i].flag = primary.flag;
        members[i].rating = primary.rating;
        drift.push(members[i]);
      }
    }
  }
  syncGroupMarks(drift);
}

// Write reconciled group marks back, quietly and in one request. Normally
// there is nothing to do; when there is, doing it now is what keeps the DB
// agreeing with the cell the user is looking at.
function syncGroupMarks(drift) {
  if (!drift.length) return;
  const byMark = new Map();
  for (const p of drift) {
    const k = p.flag + "/" + p.rating;
    (byMark.get(k) || byMark.set(k, []).get(k)).push(p.path);
  }
  for (const [k, paths] of byMark) {
    const [flag, rating] = k.split("/").map(Number);
    post("/api/mark", { paths, flag, rating }).catch(() => {});
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
function matchesSearch(p, q) {
  if (!q) return true;
  // a group is one item, so a search that names the RAW should find the cell
  // its JPEG is fronting
  if (p.filename.toLowerCase().includes(q)) return true;
  return !!(p.members && p.members.some(
    (m) => m.slice(m.replace(/\\/g, "/").lastIndexOf("/") + 1).toLowerCase().includes(q)));
}
function matches(p) {
  if (p._hidden) return false;
  return matchesFlag(p, S.filter) && matchesType(p, S.typeFilter) &&
         matchesSearch(p, S.search);
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
    (S.compare.length ? ` · <b style="color:var(--star)">${S.compare.length}</b> selected` : "") +
    (S.search ? ` · <b>${S.view.length}</b> matching` : "");
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
    const title = escapeHtml(p.groupExts.join(", "));
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
      `<div class="name">${escapeHtml(p.filename)}</div>` +
      typeBadge(p) +
      (hasEdits(p) ? `<div class="editbadge" title="Edited">✎</div>` : "") +
      (cmpIdx >= 0 ? `<div class="cmpnum">${cmpIdx + 1}</div>` : "") +
      `<div class="badges"><span class="flag"></span><span class="stars">${starStr(p.rating)}</span></div>`;
    if (i === S.cursor) cell.classList.add("sel");
    if (cmpIdx >= 0) cell.classList.add("cmp");
    // Plain click moves the cursor; the modifiers build a selection the way a
    // file manager does, so a set can be gathered with the mouse alone instead
    // of only with Space.
    cell.addEventListener("click", (e) => {
      if (e.shiftKey) { selectRange(S.cursor, i); return; }
      if (e.ctrlKey || e.metaKey) { toggleCompare(p.path); setCursor(i, false); return; }
      setCursor(i);
    });
    cell.addEventListener("dblclick", () => openLoupe(i));
    cell.addEventListener("mouseenter", () => { if (S.mouseMode) setHover(i); });
    cell.addEventListener("mouseleave", () => { if (S.hover === i) setHover(null); });
    const thumb = cell.querySelector("img");
    // an undecodable negative in RAW view must not leave a row of broken icons
    thumb.addEventListener("error", () => previewFailed(p.path), { once: true });
    frag.appendChild(cell);
    io.observe(thumb);
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
  // rebuilding className would drop the mouse-mode hover outline mid-cull
  cell.className = cellClass(p) + (i === S.cursor ? " sel" : "") +
    (i === S.hover && S.mouseMode ? " hover" : "");
  const cmpIdx = S.compare.indexOf(p.path);
  if (cmpIdx >= 0) cell.classList.add("cmp");
  cell.querySelector(".stars").textContent = starStr(p.rating);
  let eb = cell.querySelector(".editbadge");
  if (hasEdits(p) && !eb) {
    eb = document.createElement("div");
    eb.className = "editbadge"; eb.title = "Edited"; eb.textContent = "✎";
    cell.appendChild(eb);
  } else if (!hasEdits(p) && eb) { eb.remove(); }
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

// how many rows a Page Up/Down should move: one screenful, minus a row of
// overlap so you can see where you came from
function rowsPerScreen() {
  const cell = grid.querySelector(".cell");
  const h = cell ? cell.offsetHeight + 8 : 208;
  return Math.max(1, Math.floor(grid.clientHeight / h) - 1);
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

function toggleMouseMode(on, quiet) {
  S.mouseMode = (on === undefined) ? !S.mouseMode : !!on;
  document.body.classList.toggle("mousemode", S.mouseMode);
  $("mouseBtn").classList.toggle("active", S.mouseMode);
  if (!S.mouseMode) setHover(null);
  if (!quiet) toast(S.mouseMode ? "Mouse mode ON — hotkeys act on the hovered photo" : "Mouse mode off");
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
  if (S.viewer) { renderViewerMeta(); syncFilmstrip(last.map((it) => it.path)); }
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
  if (S.viewer) { renderViewerMeta(); syncFilmstrip([path]); }
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

// Shift + a flag or a rating key marks the whole selection at once. One
// snapshot, so U takes the whole batch back, and one request, so 200 photos is
// as fast as one.
async function markSelection(fields) {
  const targets = S.compare.slice();
  if (!targets.length) { toast("Nothing selected — Space, or shift-click, to select"); return; }
  snapshotMarks(targets);
  const paths = [];
  for (const pp of targets) {
    const p = S.byPath.get(pp);
    if (!p) continue;
    for (const tp of (p.members && p.members.length ? p.members : [pp])) {
      const t = S.byPath.get(tp);
      if (!t || paths.includes(tp)) continue;
      if (fields.flag !== undefined) t.flag = fields.flag;
      if (fields.rating !== undefined) t.rating = fields.rating;
      paths.push(tp);
    }
  }
  S.view.forEach((p, i) => { if (targets.includes(p.path)) refreshCell(i); });
  updateCounts();
  if (S.viewer) { renderViewerMeta(); syncFilmstrip(targets); }
  const what = fields.flag !== undefined
    ? { 1: "kept", "-1": "rejected", 0: "unflagged" }[fields.flag]
    : `rated ${fields.rating}★`;
  toast(`${targets.length} photo${targets.length === 1 ? "" : "s"} ${what}`);
  try {
    await post("/api/mark", { paths, flag: fields.flag, rating: fields.rating });
  } catch (e) { toast("Save failed: " + e.message); }
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
// The compare set doubles as the grid's selection: 3 or fewer open side by
// side, more run the tournament, and any size is a target for a bulk mark,
// a paste or a preset. The cap is what a tournament stays sane at.
const COMPARE_MAX = 200;
function toggleCompare(path) {
  const i = S.compare.indexOf(path);
  if (i >= 0) S.compare.splice(i, 1);
  else {
    if (S.compare.length >= COMPARE_MAX) { toast(`Compare holds at most ${COMPARE_MAX}`); return; }
    S.compare.push(path);
  }
  const vi = S.view.findIndex((p) => p.path === path);
  if (vi >= 0) refreshCell(vi);
  // renumber others
  S.view.forEach((p, idx) => { if (S.compare.includes(p.path)) refreshCell(idx); });
  updateCounts();
  updatePasteBtn();
}

// Shift-click: add everything between the cursor and the clicked cell, then
// leave the cursor on the click so a second shift-click extends from there.
function selectRange(from, to) {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  let added = 0;
  for (let i = lo; i <= hi; i++) {
    const p = S.view[i];
    if (!p || S.compare.includes(p.path)) continue;
    if (S.compare.length >= COMPARE_MAX) { toast(`Compare holds at most ${COMPARE_MAX}`); break; }
    S.compare.push(p.path);
    added++;
  }
  setCursor(to, false);
  S.view.forEach((p, idx) => { if (S.compare.includes(p.path)) refreshCell(idx); });
  updateCounts();
  updatePasteBtn();
  if (added) toast(`${S.compare.length} selected`, 900);
}

// Select every photo the filter is currently showing, or clear the selection if
// they are already all in it — one key for "all of these" and "none of these".
function toggleSelectAll() {
  if (!S.view.length) return;
  if (S.compare.length >= Math.min(S.view.length, COMPARE_MAX)) {
    clearCompare("Selection cleared");
    return;
  }
  S.compare = S.view.slice(0, COMPARE_MAX).map((p) => p.path);
  const sy = grid.scrollTop;
  applyFilter();
  grid.scrollTop = sy;
  updatePasteBtn();
  toast(S.compare.length < S.view.length
    ? `Selected the first ${S.compare.length} of ${S.view.length}`
    : `Selected all ${S.compare.length}`);
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
    // fall back to the active photo + the next one (hovered cell in mouse mode)
    const start = activeIndex();
    paths = S.view.slice(start, start + 2).map((p) => p.path);
  }
  if (paths.length < 1) return;
  if (paths.length <= 3) {
    S.viewer = { mode: "compare", paths, cur: 0, zoom: 1, panx: 0, pany: 0 };
    buildPanes();
    return;
  }
  // The selection is also what bulk marks and presets act on, so it can be
  // hundreds of photos deliberately. A tournament over that many is a hundred
  // votes, which is never what C meant — ask before starting one.
  if (paths.length > 12 &&
      !confirm(`Run a knock-out over ${paths.length} photos? That is ` +
               `${paths.length - 1} votes. Cancel to keep the selection as it is.`)) {
    return;
  }
  startTournament(paths);
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
    img.draggable = false;
    img.onload = () => {
      if (idx === 0) paneBusy(null);
      computeFit(idx, pane, img); applyTransform(); drawHistogram();
    };
    img.onerror = () => { if (idx === 0) { paneBusy(null); previewFailed(path); } };
    if (idx === 0) paneBusy(busyLabelFor(path));
    img.src = previewUrl(path);
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
  buildFilmstrip();
  syncLoupeNav();
  // the sidebar just appeared/disappeared, changing the pane's available
  // width before any image has necessarily loaded — refit defensively
  refitPanes();
  renderViewerMeta();
}

// The edge chevrons exist for the mouse; they are hidden outside loupe view and
// greyed at the ends of the folder so the arrow never lies about there being
// another photo.
function syncLoupeNav() {
  const v = S.viewer;
  const loupe = !!v && v.mode === "loupe";
  for (const [id, ok] of [["loupePrev", loupe && v.cur > 0],
                          ["loupeNext", loupe && v.cur < v.paths.length - 1]]) {
    const b = $(id);
    b.classList.toggle("hidden", !loupe);
    b.disabled = !ok;
  }
}

// A full RAW decode takes seconds and the pane would just sit there showing the
// previous photo. Anything slower than a blink gets a badge saying what it is
// waiting for; the delay keeps it off the screen for cached renders.
let busyTimer = null;
function paneBusy(text) {
  clearTimeout(busyTimer);
  const b = document.querySelector(".panebusy");
  if (!text) { if (b) b.remove(); return; }
  if (b) { b.querySelector(".panebusy-label").textContent = text; return; }
  busyTimer = setTimeout(() => {
    const pane = panesEl.children[0];
    if (!pane || pane.querySelector(".panebusy")) return;
    const el = document.createElement("div");
    el.className = "panebusy";
    el.innerHTML = `<span class="spinner"></span><span class="panebusy-label"></span>`;
    el.querySelector(".panebusy-label").textContent = text;
    pane.appendChild(el);
  }, 150);
}

// Every path that puts an image in the loupe pane routes through here, so the
// indicator can't be left running by one of them forgetting to clear it — the
// bug that used to strand it whenever a load resolved from cache instead of
// firing `onload`.
function loadIntoPane(pane, url, done) {
  const img = pane._img;
  paneBusy(busyLabelFor(S.viewer.paths[S.viewer.cur]));
  const finish = () => { paneBusy(null); done(); };
  img.onerror = () => { paneBusy(null); previewFailed(S.viewer.paths[S.viewer.cur]); };
  img.onload = finish;
  if (img.getAttribute("src") !== url) {
    img.src = url;
    if (img.complete && img.naturalWidth) finish();   // straight from cache
  } else if (img.complete && img.naturalWidth) {
    finish();
  }
}

// what the loupe is about to wait for, in words. Keyed on the path rather than
// the editor, because opening a photo sets the image going before the editor
// has been rebound to it.
const busyLabelFor = (path) =>
  (S.previewSrc === "raw" && rawMemberPath(S.byPath.get(path)))
    ? "Decoding negative…" : "Rendering…";

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
  if (S.spotMode) syncSpotOverlay();   // markers are positioned in pane pixels
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

// The zoom the pane needs for one image pixel to land on one screen pixel.
// Capped, because a 45MP frame in a narrow compare pane can want more than the
// zoom range allows.
function oneToOneZoom(f) {
  return f && f.fit ? Math.min(16, 1 / f.fit) : 1;
}

// Fit ⇄ 100%, Lightroom's Z. Zooming to 100% keeps whatever the pointer is over
// under the pointer, so double-clicking a face lands on that face; zooming back
// out always returns to the whole frame.
function zoomToggle(screenX, screenY) {
  const v = S.viewer;
  if (!v) return;
  const pane = panesEl.children[v.mode === "loupe" ? 0 : Math.max(0, v.cur)];
  if (!pane) return;
  const f = v._fit[+pane.dataset.idx];
  if (!f) return;
  if (v.zoom > 1.001) { resetZoom(); return; }
  const target = oneToOneZoom(f);
  if (target <= 1.001) { toast("Already showing every pixel", 900); return; }
  if (screenX === undefined) {
    const r = pane.getBoundingClientRect();
    screenX = r.left + r.width / 2; screenY = r.top + r.height / 2;
  }
  zoomAt(screenX, screenY, target / v.zoom);
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
    if (e.button === 2) return;   // right-click opens the menu; it must not pan
    paneDrag = { pane, lx: e.clientX, ly: e.clientY };
    pane.classList.add("grabbing");
  });
  // panning with the middle button is the documented way to move around while
  // retouching, and the browser's autoscroll would fight it
  pane.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  pane.addEventListener("dblclick", (e) => zoomToggle(e.clientX, e.clientY));
}

function markCurPane() {
  if (S.viewer.mode !== "compare") return;
  [...panesEl.children].forEach((p) => p.classList.toggle("cur", +p.dataset.idx === S.viewer.cur));
  renderViewerMeta();
}

// ---- filmstrip: the rest of the shoot along the bottom of the loupe. It is
// how you get around with the mouse without going back to the grid, and it is
// the only thing in loupe view that shows where in the folder you are.
// Built once per loupe session (the path list is fixed for its lifetime) and
// lazily loaded, so opening the loupe on photo 1 of 3000 costs one screenful
// of thumbnails, not three thousand. ----
let stripIo = null;
function buildFilmstrip() {
  const el = $("filmstrip");
  const v = S.viewer;
  const loupe = !!v && v.mode === "loupe";
  const show = loupe && S.showStrip;
  $("stripBtn").classList.toggle("active", S.showStrip);
  $("stripBtn").disabled = !loupe;      // compare and the tournament have no strip
  $("zoomFitBtn").disabled = !v;
  el.classList.toggle("hidden", !show);
  if (!show) { el.innerHTML = ""; return; }
  if (stripIo) stripIo.disconnect();
  stripIo = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      if (!img.src && img.dataset.src) img.src = img.dataset.src;
      stripIo.unobserve(img);
    }
  }, { root: el, rootMargin: "600px" });

  const frag = document.createDocumentFragment();
  v.paths.forEach((path, i) => {
    const p = S.byPath.get(path);
    const cell = document.createElement("div");
    cell.className = "fs-cell";
    cell.dataset.i = i;
    cell.title = p ? p.filename : "";
    cell.innerHTML = `<img data-src="${thumbUrl(path)}" alt="" />` +
      `<span class="fs-flag"></span><span class="fs-stars"></span>`;
    cell.addEventListener("click", () => loupeGo(i));
    frag.appendChild(cell);
    stripIo.observe(cell.querySelector("img"));
  });
  el.innerHTML = "";
  el.appendChild(frag);
  stripCur = -1;
  syncFilmstrip(v.paths);
}

// Marks and the current-photo highlight change constantly; the cells don't.
// Only the frames that actually moved are rewritten — `paths` names them, and
// the old and new cursor positions are always included. Rewriting all three
// thousand of them on every keystroke of a cull would be felt.
let stripCur = -1;
function syncFilmstrip(paths) {
  const el = $("filmstrip");
  if (el.classList.contains("hidden") || !el.children.length) return;
  const v = S.viewer;
  if (!v || v.mode !== "loupe") return;
  const touched = new Set([v.cur, stripCur].filter((i) => i >= 0));
  if (paths) {
    const want = new Set(paths);
    v.paths.forEach((path, i) => { if (want.has(path)) touched.add(i); });
  }
  for (const i of touched) {
    const cell = el.children[i];
    const p = cell && S.byPath.get(v.paths[i]);
    if (!p) continue;
    cell.className = "fs-cell" +
      (p.flag === 1 ? " flag-keep" : p.flag === -1 ? " flag-reject" : "") +
      (i === v.cur ? " cur" : "") +
      (S.compare.includes(p.path) ? " cmp" : "");
    cell.querySelector(".fs-stars").textContent = starStr(p.rating);
  }
  if (stripCur !== v.cur) {
    stripCur = v.cur;
    const cur = el.children[v.cur];
    if (cur) cur.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

function toggleFilmstrip() {
  S.showStrip = !S.showStrip;
  localStorage.setItem("showStrip", S.showStrip ? "1" : "0");
  buildFilmstrip();
  refitPanes();
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
  loadIntoPane(pane, previewUrl(v.paths[v.cur]), () => {
    computeFit(0, pane, img); applyTransform(); updateHud(); drawHistogram();
  });
  applyTransform();
  updateHud();
  // keep grid cursor in sync
  const gi = S.view.findIndex((p) => p.path === v.paths[v.cur]);
  if (gi >= 0) setCursor(gi, true);
  if (S.editor) bindEditor(v.paths[v.cur]);   // editor follows the current photo
  renderViewerMeta();
  syncLoupeNav();
  syncFilmstrip();
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
    // Shooting data lives in the JPEG's EXIF, but the dimensions and file size
    // have to describe whatever the loupe is actually rendering — in RAW view
    // that is a different, larger file.
    const raw = rawRenderPath(p);
    const [m, rawMeta] = await Promise.all([
      api("/api/meta?path=" + encodeURIComponent(p.path)),
      raw ? api("/api/meta?path=" + encodeURIComponent(raw) + "&full=1").catch(() => null)
          : Promise.resolve(null),
    ]);
    if (rawMeta) {
      if (rawMeta.width) { m.width = rawMeta.width; m.height = rawMeta.height; }
      m.size = rawMeta.size;
    }
    const cur = currentPhoto();   // user may have navigated meanwhile
    if (!S.showMeta || !cur || cur.path !== p.path) return;
    const rows = [
      ["Camera", m.camera],
      ["Lens", m.lens],
      ["Focal", m.focal],
      ["Shutter", m.shutter],
      ["Aperture", m.aperture],
      ["ISO", m.iso && String(m.iso).replace(/^ISO /, "")],
      ["Source", raw ? "RAW · " + raw.split(/[\\/]/).pop() : null],
      ["Size", m.width ? `${m.width} × ${m.height}` : null],
      ["File", m.size >= 1048576 ? (m.size / 1048576).toFixed(1) + " MB"
                                 : Math.round(m.size / 1024) + " KB"],
      ["Taken", p.taken ? new Date(p.taken * 1000).toLocaleString() : null],
    ].filter(([, v]) => v);
    el.innerHTML = rows.map(([k, v]) =>
      `<div class="mrow"><span class="mkey">${k}</span><span>${escapeHtml(v)}</span></div>`).join("") ||
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
const histCache = new Map();     // key -> {luma, means} of the ORIGINAL (edits={})
const autoCache = new Map();     // key -> means of the AUTO-LEVELS-ONLY render
// The camera JPEG and the negative behind it are two different pictures, so the
// "before" curve has to be cached per render source — keying on the path alone
// left the JPEG's histogram overlaid on the RAW after the Info panel's switch.
const statKey = (path) => path + "|" + S.previewSrc;
function capCache(cache, key, val) {
  cache.set(key, val);
  if (cache.size > 50) cache.delete(cache.keys().next().value);
}
// fetch `previewUrl(path, edits)`, run `compute` on its sampled pixels, cache in `cache`
function statsFromPreview(cache, path, edits, compute) {
  const key = statKey(path);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const pixels = sampleImageData(img);
      const val = pixels ? compute(pixels) : null;
      if (val) capCache(cache, key, val);   // a failed read is not an answer to keep
      resolve(val);
    };
    img.onerror = () => resolve(null);
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
// One line per active adjustment, each tagged with the key it came from so the
// panel can switch it off and on again. `edits.off` holds the ones that are
// parked: the value is kept so toggling back restores exactly what was there.
function describeEdits(edits, disabled) {
  if (!edits) return [];
  const out = [];
  const add = (key, text) => out.push({ key, text, off: !!disabled });
  const num = (v) => `${v > 0 ? "+" : ""}${(+v).toFixed(2)}`;
  if (edits.rot) add("rot", `Rotate ${edits.rot}°`);
  if (edits.fine) add("fine", `Straighten ${edits.fine > 0 ? "+" : ""}${edits.fine}°`);
  if (edits.flipH) add("flipH", "Flip horizontal");
  if (edits.flipV) add("flipV", "Flip vertical");
  if (edits.crop) add("crop", "Cropped");
  if (edits.spots && edits.spots.length) {
    add("spots", `Retouch: ${edits.spots.length} spot${edits.spots.length > 1 ? "s" : ""}`);
  }
  if (edits.auto) add("auto", "Auto-levels");
  if (edits.bw) add("bw", "Black & white");
  if (edits.temp) add("temp", `White balance (legacy) ${num(edits.temp)}`);
  // the sliders describe themselves off the table, so a new adjustment shows up
  // here — and becomes togglable — without being spelled out a second time
  for (const key of ALL_SLIDER_KEYS) {
    const v = edits[key];
    const def = SLIDER_INFO[key];
    if (v == null || v === def.neutral) continue;
    const label = def.label.replace(/^\S+\s/, "");
    add(key, def.neutral === 1 ? `${label} ×${(+v).toFixed(2)}` : `${label} ${num(v)}`);
  }
  if (edits.border && edits.border.w) {
    add("border", `Border ${Math.round(edits.border.w * 100)}% ${edits.border.color}`);
  }
  return out;
}

// Park one adjustment in `edits.off` (or bring it back) without disturbing the
// rest — a per-change on/off switch, undoable like any other edit. Crop takes
// the spots with it: they are positioned in the cropped frame, so leaving them
// behind would heal the wrong pixels.
function toggleEditKey(key) {
  const e = clone(curEdits());
  const off = clone(e.off || {});
  const keys = key === "crop" ? ["crop", "spots"] : [key];
  const disabling = e[key] !== undefined;
  for (const k of keys) {
    if (disabling) {
      if (e[k] !== undefined) { off[k] = e[k]; delete e[k]; }
    } else if (off[k] !== undefined) {
      e[k] = off[k]; delete off[k];
    }
  }
  if (Object.keys(off).length) e.off = off; else delete e.off;
  pushEdit(e);
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
  const e = p ? p.edits : null;
  const list = describeEdits(e).concat(describeEdits(e && e.off, true));

  if (p && hasEdits(p)) {   // nothing to compare against when there are no edits
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
        if (wb) list.push({ text: `Fuji WB to match Auto: ${wb} (approx.)` });
      }
    }
  }

  $("histChanges").innerHTML = list.length
    ? list.map((c) => c.key
        ? `<div class="hchg togglable${c.off ? " isoff" : ""}" data-key="${c.key}"` +
          ` title="Click to switch this adjustment ${c.off ? "back on" : "off"}">` +
          `<span class="hchk">${c.off ? "☐" : "☑"}</span>${escapeHtml(c.text)}</div>`
        : `<div class="hchg">${escapeHtml(c.text)}</div>`).join("")
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
      `<span class="nm">${typeBadge(p)}${escapeHtml(p.filename)}</span>` +
      `<span>${flag} <span class="stars" style="color:var(--star)">${starStr(p.rating)}</span></span>`;
    pane.classList.toggle("cur", v.mode === "compare" && idx === v.cur);
  });
  updateHud();
}

function updateHud() {
  const v = S.viewer; if (!v) return;
  if (v.mode === "tournament") {
    const l = S.byPath.get(v.left), r = S.byPath.get(v.right);
    const nm = (x) => (x ? escapeHtml(x.filename) : "");
    $("hudLeft").innerHTML =
      `Which is better? <b>${nm(l)}</b> vs <b>${nm(r)}</b>`;
    $("hudInfo").textContent =
      `match ${v.round}/${v.total} · ←/S = left · →/F = right · Esc cancels`;
    return;
  }
  const p = currentPhoto();
  const pos = v.mode === "loupe" ? `${v.cur + 1}/${v.paths.length}` : `compare ${v.paths.length}`;
  const f = v._fit[v.mode === "loupe" ? 0 : Math.max(0, v.cur)];
  // "100%" reads better than "6.1x" when that is what the zoom actually means
  const oneToOne = f ? oneToOneZoom(f) : 1;
  const zoomTxt = Math.abs(v.zoom - oneToOne) < 0.02 && oneToOne > 1.02
    ? "100%" : `${v.zoom.toFixed(1)}×`;
  $("hudLeft").textContent = p ? p.filename : "";
  $("hudInfo").textContent =
    `${pos} · zoom ${zoomTxt} · scroll=zoom · Z=100% · Esc to close`;
  $("zoomFitBtn").classList.toggle("active", v.zoom > 1.001);
}

function closeViewer() {
  paneBusy(null);
  S.viewer = null;
  S.editor = null; S.cropMode = false;
  // retouch state outlived the viewer: the mode flag stayed on, so the button
  // came back pressed and a stray mouseup could still push a stroke
  S.spotMode = false; paint = null; spotCursor = null;
  $("retouchBtn").classList.remove("active");
  for (const id of ["cropOverlay", "spotOverlay"]) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
  $("editBar").classList.add("hidden");
  $("editBar").classList.remove("collapsed-full");   // sidebar hide is transient, not a saved preference
  S.sidebarCollapsed = false;
  $("metaPanel").classList.add("hidden");
  $("histPanel").classList.add("hidden");
  $("filmstrip").classList.add("hidden");
  $("filmstrip").innerHTML = "";
  if (stripIo) { stripIo.disconnect(); stripIo = null; }
  $("loupePrev").classList.add("hidden");
  $("loupeNext").classList.add("hidden");
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
// `edits.off` holds adjustments the user switched off from the change list. It
// has to be stored (that is the only copy of the parked values) but it changes
// nothing about the picture, so a stack holding only `off` is not an edit.
const hasEdits = (p) =>
  !!(p && p.edits && Object.keys(p.edits).some((k) => k !== "off"));
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
  if (S.spotMode) exitRetouch(false);    // spots belong to the photo we're leaving
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
  // A slider double-clicked to a value it already had, a preset applied twice,
  // Reset on an untouched photo: pushing an identical state would spend an undo
  // step doing nothing, so Ctrl+Z would look broken for one press.
  if (JSON.stringify(edits) === JSON.stringify(curEdits())) {
    syncEditControls();
    renderEditPreview();
    return;
  }
  p._hist = p._hist.slice(0, p._hidx + 1);
  p._hist.push(edits);
  p._hidx = p._hist.length - 1;
  commitEdit();
}
function undoEdit() { const p = editorPhoto(); if (p && p._hist && p._hidx > 0) { p._hidx--; commitEdit(); } }
function redoEdit() { const p = editorPhoto(); if (p && p._hist && p._hidx < p._hist.length - 1) { p._hidx++; commitEdit(); } }

async function commitEdit() {
  const p = editorPhoto();
  if (!p) return;
  if (S.cropMode) exitCropMode(false);   // edits changed under the overlay — drop it
  if (S.editor.showOrig) { S.editor.showOrig = false; $("origBtn").classList.remove("active"); }
  const edits = curEdits();
  p.edits = (edits && Object.keys(edits).length) ? clone(edits) : null;
  p._ev = (p._ev || 0) + 1;   // bust browser cache for thumb/stored preview
  // the stack may have been replaced wholesale (preset, paste, reset, undo, a
  // parked change switched back on), so the panel is resynced on every commit —
  // for a slider-driven edit this just writes back what the slider already shows
  syncEditControls();
  renderEditPreview();
  const vi = S.view.indexOf(p);
  if (vi >= 0) refreshCell(vi);
  try {
    await Promise.all(editTargets(p).map((tp) =>
      post("/api/edit", { path: tp, edits: p.edits })));
    refreshThumb(p);   // only after the server knows the new edits (avoids a stale fetch)
  } catch (err) { toast("Edit save failed: " + err.message); }
}

// A RAW+JPEG pair is one photo to the person editing it, but two rows on disk
// and in the DB — and the JPEG is the one the editor is bound to. Mirror the
// stack onto every member (the same thing mark() does with flags) so the RAW
// carries the changes too: its own preview shows them, exporting it renders
// them, and turning grouping off doesn't reveal an unedited twin.
function editTargets(p) {
  const paths = (p.members && p.members.length) ? p.members : [p.path];
  for (const tp of paths) {
    const t = S.byPath.get(tp);
    if (!t || t === p) continue;
    t.edits = p.edits ? clone(p.edits) : null;
    t._hist = null; t._hidx = 0;    // its own history would now be a lie
    t._ev = (t._ev || 0) + 1;
  }
  return paths;
}

// re-fetch a photo's grid thumbnail after its stored edits changed
function refreshThumb(p) {
  const vi = S.view.indexOf(p);
  if (vi < 0) return;
  setThumbSrc(grid.querySelector(`.cell[data-i="${vi}"] img`), p);
}

// same, for every visible cell — the JPEG/RAW switch repoints all of them
function refreshThumbs() {
  grid.querySelectorAll(".cell img").forEach((img) =>
    setThumbSrc(img, S.view[+img.parentElement.dataset.i]));
}

function setThumbSrc(img, p) {
  if (!img || !p) return;
  const u = thumbUrl(p.path);
  if (img.src) img.src = u;
  else img.dataset.src = u;   // not lazily loaded yet
}

// server render of the edits dict into the pane. Live CSS layers (filter,
// border, straighten transform) stay up until the baked image arrives, so
// there's no flash back to the unedited base.
function renderEditPreview(overrideEdits, keepLive) {
  const pane = panesEl.children[0];
  if (!pane || !S.editor) return;
  const img = pane._img;
  let edits = overrideEdits !== undefined ? overrideEdits : curEdits();
  // spots are normalized against the un-bordered frame — the same one the
  // retouch overlay draws on — so the border comes off while placing them
  if (S.spotMode && overrideEdits === undefined && edits && edits.border) {
    edits = clone(edits);
    delete edits.border;
  }
  const url = previewUrl(S.editor.path, edits);
  paneBusy(busyLabelFor(S.editor.path));
  // A failed draft used to just leave the previous frame up, so a preview that
  // had stopped tracking the sliders looked like a slow one. Say so instead.
  img.onerror = () => { paneBusy(null); previewFailed(S.editor.path); };
  img.onload = () => {
    paneBusy(null);
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
  if (!S.editor.showOrig && !hasEdits(p)) { toast("No edits — this is the original"); return; }
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
  if (!hasEdits(p)) { toast("No edits to save"); return; }
  toast(rawRenderPath(p) ? "Rendering from the negative…" : "Saving…", 4000);
  try {
    const res = await post("/api/save-copy",
                           { path: p.path, source: rawRenderPath(p) || p.path });
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
  const b = e.border || {};
  $("borderW").value = b.w || 0;
  $("borderWNum").value = Math.round((b.w || 0) * 1000) / 10;
  $("borderC").value = b.color || "#ffffff";
  syncEditBadges();
}

// The on/off buttons and the spot count are derived from the edit stack, so
// they have to refresh on every commit — not only when the sliders are resynced
// (undo/redo), which is how a cleared spot list used to leave a stale count.
function syncEditBadges() {
  const e = curEdits();
  $("autoBtn").classList.toggle("active", !!e.auto);
  $("cropBtn").classList.toggle("active", !!e.crop || S.cropMode);
  $("bwBtn").classList.toggle("active", !!e.bw);
  $("retouchBtn").classList.toggle("active", S.spotMode);
  $("retouchBtn").textContent = (e.spots && e.spots.length)
    ? `\u{1FA79} Retouch (${e.spots.length})` : "\u{1FA79} Retouch";
  $("origBtn").classList.toggle("active", !!(S.editor && S.editor.showOrig));
  syncSourceRow();
}

function editAction(act) {
  const e = curEdits();
  if (act === "rotL" || act === "rotR") {
    const n = clone(e);
    n.rot = (((n.rot || 0) + (act === "rotR" ? 90 : 270)) % 360);
    delete n.crop;    // crop coords are tied to the old rotation — drop them
    pushEdit(dropSpots(n, e)); return;
  }
  if (act === "flipH" || act === "flipV") {
    const n = clone(e);
    // remove rather than store `false`: a stack of switched-off flags is not an
    // edit, and leaving them in lights the ✎ badge on an untouched photo
    if (n[act]) delete n[act]; else n[act] = true;
    delete n.crop;
    pushEdit(dropSpots(n, e)); return;
  }
  if (act === "crop") { S.cropMode ? exitCropMode() : enterCropMode(); return; }
  if (act === "grid") return toggleGrid();
  if (act === "hist") return toggleHist();
  if (act === "auto") {
    const n = clone(e);
    if (n.auto) delete n.auto; else n.auto = true;
    pushEdit(n); return;
  }
  if (act === "bw") {
    const n = clone(e);
    if (n.bw) delete n.bw; else n.bw = true;
    pushEdit(n); return;
  }
  if (act === "lensReset") {
    const n = clone(e);
    let any = false;
    for (const k of ["distort", "ca", "persV", "persH"]) {
      if (n[k] != null) { delete n[k]; any = true; }
    }
    if (!any) { toast("No lens corrections to clear"); return; }
    pushEdit(dropSpots(n, e)); return;
  }
  if (act === "srcJpeg") return setPreviewSrc("jpeg");
  if (act === "srcRaw") return setPreviewSrc("raw");
  if (act === "retouch") return toggleRetouch();
  if (act === "spotClear") {
    if (!e.spots || !e.spots.length) { toast("No spots to clear"); return; }
    const n = clone(e); delete n.spots; pushEdit(n); return;
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
  if (!p || !hasEdits(p)) { toast("No edits to copy"); return; }
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
    const all = [].concat(...targets.map((path) => editTargets(S.byPath.get(path))));
    await Promise.all(all.map((path) =>
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
  btn.textContent = n ? `📋 Paste (${n})` : "📋 Paste";
  btn.title = copiedEdits
    ? `Paste copied edits onto ${n ? n + " selected photos" : "the current photo"} (Ctrl+V)`
    : "Copy edits first: open a photo, Ctrl+C";
}

// ---- named presets: save the current edit stack, apply it later — either to
// the photo being edited, or to a whole grid selection. Stored in localStorage
// since they're just reusable templates, not per-photo state. ----
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
  $("fineRNum").value = v;   // keep the readout right after a programmatic reset
  const cur = curEdits();
  if (v === (cur.fine || 0)) { renderEditPreview(); return; }   // unchanged — settle back
  const n = clone(cur);
  if (v) n.fine = v; else delete n.fine;
  delete n.crop;    // crop coords are tied to the old geometry — drop them
  pushEdit(dropSpots(n, cur));
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
  $("borderWNum").value = Math.round(w * 1000) / 10;   // ditto for the % readout
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
// Every tonal/lens slider in one table, and the sidebar rows are generated
// from it — a new adjustment is one row here, not a block of markup plus four
// places that have to learn its name.
//   live "css": previewable with a CSS/SVG filter while dragging (exact or
//               near enough that the server render doesn't visibly jump)
//   live "srv": no CSS equivalent — the server renders a draft while dragging
const SLIDER_DEFS = [
  // group,     key,          label,               min,  max, step, neutral, live, ticks
  ["lens",    "distort",   "\u{1F6E2} Distortion",   -0.5,  0.5, 0.01, 0, "srv", 11],
  ["lens",    "ca",        "\u{1F308} Chromatic ab.",  -1,    1, 0.02, 0, "srv", 11],
  ["lens",    "persV",     "\u2195 Perspective V",     -1,    1, 0.02, 0, "srv", 11],
  ["lens",    "persH",     "\u2194 Perspective H",     -1,    1, 0.02, 0, "srv", 11],

  ["light",   "exposure",  "\u2600 Exposure",          -3,    3, 0.05, 0, "css", 13],
  ["light",   "contrast",  "\u25D0 Contrast",         0.2,    2, 0.02, 1, "css", 10],
  ["light",   "highlights","\u25B2 Highlights",        -1,    1, 0.02, 0, "srv", 11],
  ["light",   "shadows",   "\u25BC Shadows",           -1,    1, 0.02, 0, "srv", 11],
  ["light",   "whites",    "\u25A1 Whites",            -1,    1, 0.02, 0, "srv", 11],
  ["light",   "blacks",    "\u25A0 Blacks",            -1,    1, 0.02, 0, "srv", 11],
  ["light",   "bright",    "\u{1F506} Brightness",    0.2,    2, 0.02, 1, "css", 10],

  ["color",   "wbR",       "\u{1F534} WB Red",         -1,    1, 0.02, 0, "css", 11],
  ["color",   "wbB",       "\u{1F535} WB Blue",        -1,    1, 0.02, 0, "css", 11],
  ["color",   "vibrance",  "\u{1F321} Vibrance",       -1,    1, 0.02, 0, "srv", 11],
  ["color",   "saturation","\u{1F3A8} Saturation",      0,    2, 0.02, 1, "css", 11],

  ["detail",  "clarity",   "\u25CE Clarity",           -1,    1, 0.02, 0, "srv", 11],
  ["detail",  "sharpness", "\u{1F52A} Sharpness",       0,    3, 0.05, 1, "css", 13],
  ["detail",  "denoise",   "\u224B Noise reduction",    0,    1, 0.02, 0, "srv", 11],

  ["effects", "vignette",  "\u25CD Vignette",          -1,    1, 0.02, 0, "srv", 11],
  ["effects", "grain",     "\u25A8 Grain",              0,    1, 0.02, 0, "srv", 11],
];
const SLIDER_INFO = {};
SLIDER_DEFS.forEach((d) => {
  SLIDER_INFO[d[1]] = { group: d[0], key: d[1], label: d[2], min: d[3], max: d[4],
                        step: d[5], neutral: d[6], live: d[7], ticks: d[8] };
});
const LIVE_KEYS = SLIDER_DEFS.filter((d) => d[7] === "css").map((d) => d[1]);
const ALL_SLIDER_KEYS = SLIDER_DEFS.map((d) => d[1]);
const neutralOf = (k) => (SLIDER_INFO[k] ? SLIDER_INFO[k].neutral : 0);

function buildSliders() {
  document.querySelectorAll("#editBar [data-sliders]").forEach((host) => {
    host.innerHTML = SLIDER_DEFS.filter((d) => d[0] === host.dataset.sliders).map((d) => {
      const [, key, label, min, max, step, neutral] = d;
      return `<div class="ed-row">
        <div class="ed-head"><span class="ed-label">${label}</span>
          <input type="number" class="num" data-num="${key}" min="${min}" max="${max}"
                 step="${step}" value="${neutral.toFixed(2)}" /></div>
        <datalist id="tick_${key}"></datalist>
        <input type="range" data-edit="${key}" min="${min}" max="${max}" step="${step}"
               value="${neutral}" list="tick_${key}" title="double-click to reset" />
      </div>`;
    }).join("");
  });
  SLIDER_DEFS.forEach((d) => fillTicks("tick_" + d[1], d[3], d[4], d[8]));
}
buildSliders();

let sliderDragging = false;

// the edit stack minus everything the live CSS filter is about to stand in for
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
  // exposure is a linear-light multiply on the server and a plain gain here;
  // close enough over a drag that the baked render doesn't visibly jump
  const gain = Math.pow(2, sliderVal("exposure")) * sliderVal("bright");
  parts.push(`brightness(${gain.toFixed(4)}) contrast(${sliderVal("contrast")}) ` +
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
// Retouch spots are positioned on the final frame, so anything upstream that
// moves pixels (rotate, straighten, lens correction) leaves them healing the
// wrong place. Crop is remapped instead (remapSpots); the rest drop the spots,
// and say so — a silently misplaced heal is worse than a lost one.
function dropSpots(next, prev) {
  if (!prev || !prev.spots || !prev.spots.length) return next;
  delete next.spots;
  toast("Geometry changed \u2014 retouch spots cleared");
  return next;
}

// the edit stack with one slider's value swapped in (neutral = key removed)
function editsWith(inp, announce) {
  const n = clone(curEdits());
  const key = inp.dataset.edit, val = parseFloat(inp.value);
  if (Math.abs(val - neutralOf(key)) < 1e-6) delete n[key]; else n[key] = val;
  const def = SLIDER_INFO[key];
  if (def && def.group === "lens" && n.spots) {
    if (announce) dropSpots(n, curEdits()); else delete n.spots;
  }
  return n;
}

// Sliders with no CSS equivalent (highlights/shadows, lens, vignette, grain…)
// preview by asking the server for a draft render, debounced to one in flight
// per pause. The draft comes off the RAM-cached 2400px base, so it lands in
// well under the time it takes to move to the next slider.
let srvTimer = null;
function srvSliderInput(inp) {
  if (!S.editor) return;
  const n = editsWith(inp);
  clearTimeout(srvTimer);
  srvTimer = setTimeout(() => { if (S.editor) renderEditPreview(n); }, 130);
}

function sliderInput(inp) {
  const num = inp.parentElement.querySelector("input.num");
  if (num) num.value = parseFloat(inp.value).toFixed(2);
  const pane = panesEl.children[0];
  if (!pane || !S.editor) return;
  const def = SLIDER_INFO[inp.dataset.edit];
  if (def && def.live === "srv") { srvSliderInput(inp); return; }
  // first move: drop the baked-in tonal layer so the live filter isn't doubled
  if (!sliderDragging) { sliderDragging = true; renderEditPreview(geomEdits(), true); }
  pane._img.style.filter = liveFilter();
}
function sliderCommit(inp) {
  sliderDragging = false;
  clearTimeout(srvTimer);
  // the slider may have been set programmatically (double-click reset), so the
  // numeric twin has to be re-synced here, not only while dragging
  const num = inp.parentElement.querySelector("input.num");
  if (num) num.value = parseFloat(inp.value).toFixed(2);
  pushEdit(editsWith(inp, true));   // server bakes the real result; live filter stays until it loads
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
  if (S.spotMode) exitRetouch(false);   // about to render its own frame anyway
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

  // Snap the dragged corner to the chosen aspect ratio, then shrink whatever
  // spills past the edge of the image. The pane scale is uniform, so a ratio
  // held in screen pixels is the same ratio in image pixels.
  const fixAspect = (x0, y0, x1, y1) => {
    const ar = cropAspectRatio();
    if (!ar) return [x1, y1];
    const sgx = x1 >= x0 ? 1 : -1, sgy = y1 >= y0 ? 1 : -1;
    let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (w > h * ar) h = w / ar; else w = h * ar;
    const maxW = sgx > 0 ? imgL + imgW - x0 : x0 - imgL;
    const maxH = sgy > 0 ? imgT + imgH - y0 : y0 - imgT;
    const k = Math.min(1, maxW / Math.max(w, 1e-6), maxH / Math.max(h, 1e-6));
    return [x0 + sgx * w * k, y0 + sgy * h * k];
  };

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
    const [cx, cy] = fixAspect(sx, sy, clampX(e.clientX - r.left), clampY(e.clientY - r.top));
    sel.style.left = Math.min(sx, cx) + "px"; sel.style.top = Math.min(sy, cy) + "px";
    sel.style.width = Math.abs(cx - sx) + "px"; sel.style.height = Math.abs(cy - sy) + "px";
  });
  ov.addEventListener("mouseup", (e) => {
    if (!drag) return; drag = false;
    const r = ov.getBoundingClientRect();
    const [cx, cy] = fixAspect(sx, sy, clampX(e.clientX - r.left), clampY(e.clientY - r.top));
    const x0 = Math.min(sx, cx), y0 = Math.min(sy, cy);
    const x1 = Math.max(sx, cx), y1 = Math.max(sy, cy);
    if (x1 - x0 < 8 || y1 - y0 < 8) { toast("Crop too small"); return; }
    const crop = [(x0 - imgL) / imgW, (y0 - imgT) / imgH,
                  (x1 - imgL) / imgW, (y1 - imgT) / imgH]
                 .map((n) => Math.max(0, Math.min(1, +n.toFixed(4))));
    S.cropMode = false; $("cropBtn").classList.remove("active"); ov.remove();
    const cur = curEdits();
    const n = clone(cur);
    const moved = remapSpots(cur.spots, cur.crop, crop, f.nw, f.nh);
    if (moved && moved.length) n.spots = moved; else delete n.spots;
    n.crop = crop;
    pushEdit(n);
  });
}

// Retouch entries are stored in the *cropped* frame, so re-cropping would slide
// them off their blemishes. Map them through the old crop into the new one
// instead of quietly throwing the retouch work away; entries that end up
// entirely outside the new frame are dropped, because there is nothing left for
// them to fix.
//
// An entry is {pts, r, dx, dy}: a painted region plus one source offset. The
// pre-brush shape {x, y, sx, sy, r} still turns up in stacks saved before the
// brush existed and in presets, so both are mapped. This used to map only the
// old shape — on a current stroke every field came out NaN and the filter then
// dropped it, so the first re-crop silently deleted the entire retouch stack.
function remapSpots(spots, oldCrop, newCrop, nw, nh) {
  if (!spots || !spots.length) return spots;
  const o = oldCrop && oldCrop.length === 4 ? oldCrop : [0, 0, 1, 1];
  const ow = o[2] - o[0], oh = o[3] - o[1];
  const cw = newCrop[2] - newCrop[0], ch = newCrop[3] - newCrop[1];
  if (cw <= 0 || ch <= 0 || ow <= 0 || oh <= 0) return spots;
  // the radius is a fraction of the frame's short edge, which just changed
  const rk = Math.min(ow * nw, oh * nh) / Math.min(cw * nw, ch * nh);
  const mx = (x) => rnd5((o[0] + x * ow - newCrop[0]) / cw);
  const my = (y) => rnd5((o[1] + y * oh - newCrop[1]) / ch);
  const inside = (x, y) => x > 0 && x < 1 && y > 0 && y < 1;

  const out = [];
  for (const s of spots) {
    const n = Object.assign({}, s, { r: rnd5(s.r * rk) });
    if (s.pts) {
      n.pts = s.pts.map((p) => [mx(p[0]), my(p[1])]);
      // dx/dy are a displacement, not a position: they rescale with the frame
      // rather than translating with it
      if (s.dx !== undefined) n.dx = rnd5(s.dx * ow / cw);
      if (s.dy !== undefined) n.dy = rnd5(s.dy * oh / ch);
      // any part of a stroke still on the picture is worth keeping
      if (!n.pts.some((p) => inside(p[0], p[1]))) continue;
    } else {
      n.x = mx(s.x); n.y = my(s.y);
      if (s.sx !== undefined) { n.sx = mx(s.sx); n.sy = my(s.sy); }
      if (!inside(n.x, n.y)) continue;
    }
    out.push(n);
  }
  return out;
}

function cropAspectRatio() {
  const v = $("cropAspect").value;
  if (!v) return 0;
  if (v === "orig") {
    const f = S.viewer && S.viewer._fit[0];
    return f && f.nh ? f.nw / f.nh : 0;
  }
  return parseFloat(v) || 0;
}

// ---- retouch: brush over what you want gone, or tap a single blemish ----
// A retouch entry is a painted path plus one source offset:
//   {pts: [[x, y], …], r, dx, dy, mode}
// One point is a spot, several are a stroke, and the renderer treats them the
// same. Coordinates are normalized against the displayed (cropped, un-bordered)
// frame — what you paint on is exactly what the server heals, at any zoom.
let paint = null;        // the stroke being drawn
let spotCursor = null;   // {x, y} in pane pixels — where the brush ring is drawn


function spotRadius() {
  return Math.max(0.005, Math.min(0.15, parseFloat($("spotSize").value) || 0.03));
}
const spotTool = () => $("spotTool").value;          // "brush" | "spot"

function toggleRetouch(on) {
  const want = on === undefined ? !S.spotMode : !!on;
  if (want && !S.editor) return;
  if (want === S.spotMode) return;
  if (want && S.cropMode) exitCropMode(false);
  S.spotMode = want;
  $("retouchBtn").classList.toggle("active", want);
  if (want && S.editor && S.editor.showOrig) {
    S.editor.showOrig = false; $("origBtn").classList.remove("active");
  }
  renderEditPreview();            // border comes off / goes back on
  if (!want) {
    paint = null; spotCursor = null;
    const ov = document.getElementById("spotOverlay");
    if (ov) ov.remove();
  } else {
    // park the brush ring in the middle of the pane so its size is visible the
    // moment the mode turns on, before the mouse has moved
    const pane = panesEl.children[0];
    if (pane) spotCursor = { x: pane.clientWidth / 2, y: pane.clientHeight / 2 };
    toast(spotTool() === "brush"
      ? "Brush over what you want gone — Esc exits"
      : "Click a blemish — the source is picked for you — Esc exits", 2600);
  }
}

function exitRetouch(rerender = true) {
  if (!S.spotMode) return;
  S.spotMode = false;
  paint = null; spotCursor = null;
  $("retouchBtn").classList.remove("active");
  const ov = document.getElementById("spotOverlay");
  if (ov) ov.remove();
  if (rerender && S.editor) renderEditPreview();
}

// pane pixels <-> normalized image coords, inverting the CSS transform that
// applyTransform() writes (fit scale, zoom, pan)
function paneToImg(f, px, py) {
  const s = f.fit * S.viewer.zoom;
  return [((px - f.PW / 2 - S.viewer.panx) / s + f.nw / 2) / f.nw,
          ((py - f.PH / 2 - S.viewer.pany) / s + f.nh / 2) / f.nh];
}
function imgToPane(f, u, v) {
  const s = f.fit * S.viewer.zoom;
  return [f.PW / 2 + S.viewer.panx + (u * f.nw - f.nw / 2) * s,
          f.PH / 2 + S.viewer.pany + (v * f.nh - f.nh / 2) * s];
}

function syncSpotOverlay() {
  const pane = panesEl.children[0];
  if (!pane || !S.viewer || S.viewer.mode !== "loupe") return;
  let ov = document.getElementById("spotOverlay");
  if (!S.spotMode) { if (ov) ov.remove(); return; }
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "spotOverlay";
    ov.className = "spotoverlay";
    attachSpotHandlers(ov);
  }
  if (ov.parentElement !== pane) pane.appendChild(ov);
  drawSpotMarkers(ov);
}

// one painted region, drawn at the brush width: a round-capped polyline, or a
// circle when there is only the single point a tap leaves behind
function regionSvg(f, entry, wide, cls) {
  const pts = entry.pts || [[entry.x, entry.y]];
  const xy = pts.map((p) => imgToPane(f, p[0], p[1]));
  if (xy.length < 2) {
    return `<circle cx="${xy[0][0]}" cy="${xy[0][1]}" r="${wide / 2}" class="${cls}" />`;
  }
  return `<polyline points="${xy.map((p) => p[0] + "," + p[1]).join(" ")}" ` +
         `class="${cls}" style="stroke-width:${wide}" />`;
}

function drawSpotMarkers(ov) {
  const f = S.viewer && S.viewer._fit[0];
  if (!f) return;
  const shortPx = Math.min(f.nw, f.nh) * f.fit * S.viewer.zoom;
  const entries = (curEdits().spots || []).slice();
  let svg = entries.map((e) =>
    regionSvg(f, e, Math.max(4, 2 * e.r * shortPx), "spotregion")).join("");
  if (paint) {
    svg += regionSvg(f, paint, Math.max(4, 2 * paint.r * shortPx), "spotpainting");
    // the spot tool's drag picks a source instead of painting, so show where from
    if (paint.src) {
      const [px, py] = imgToPane(f, paint.pts[0][0], paint.pts[0][1]);
      const [sx, sy] = imgToPane(f, paint.src[0], paint.src[1]);
      const rr = Math.max(2, paint.r * shortPx);
      svg += `<line x1="${sx}" y1="${sy}" x2="${px}" y2="${py}" class="spotlink" />` +
             `<circle cx="${sx}" cy="${sy}" r="${rr}" class="spotsrc" />`;
    }
  } else if (spotCursor) {
    // the brush itself: a ring at the pointer, at the size the next stroke uses
    svg += `<circle cx="${spotCursor.x}" cy="${spotCursor.y}" ` +
           `r="${Math.max(2, spotRadius() * shortPx)}" class="spotbrush" />`;
  }
  ov.innerHTML = `<svg class="spotsvg">${svg}</svg>`;
}

// redraw the brush ring without touching anything else (brush-size slider)
function refreshSpotBrush() {
  const ov = document.getElementById("spotOverlay");
  if (S.spotMode && ov) drawSpotMarkers(ov);
}

// clicking inside a painted region removes it. Points along a stroke are laid
// down closer together than the brush radius, so nearest-point is the same
// answer as distance-to-path without the segment maths.
function regionAt(f, u, v) {
  const entries = curEdits().spots || [];
  const short = Math.min(f.nw, f.nh);
  return entries.findIndex((e) =>
    (e.pts || [[e.x, e.y]]).some((p) =>
      Math.hypot((u - p[0]) * f.nw / short, (v - p[1]) * f.nh / short) <= e.r));
}

function attachSpotHandlers(ov) {
  const at = (e) => {
    const f = S.viewer && S.viewer._fit[0];
    const r = ov.getBoundingClientRect();
    return f ? paneToImg(f, e.clientX - r.left, e.clientY - r.top) : null;
  };
  ov.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;   // middle/right fall through to the pane's pan
    e.preventDefault(); e.stopPropagation();
    const f = S.viewer && S.viewer._fit[0];
    const p = at(e);
    if (!f || !p) return;
    const hit = regionAt(f, p[0], p[1]);
    if (hit >= 0) {               // clicking a painted region removes it
      const n = clone(curEdits());
      n.spots = (n.spots || []).filter((_, i) => i !== hit);
      if (!n.spots.length) delete n.spots;
      pushEdit(n);
      return;
    }
    paint = { pts: [[rnd5(p[0]), rnd5(p[1])]], r: spotRadius(), mode: $("spotModeSel").value,
              tool: spotTool(), src: null, ox: e.clientX, oy: e.clientY, moved: false };
    drawSpotMarkers(ov);
  });
  ov.addEventListener("mousemove", (e) => {
    const r = ov.getBoundingClientRect();
    spotCursor = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (!paint) drawSpotMarkers(ov);
  });
  ov.addEventListener("mouseleave", () => {
    spotCursor = null;
    if (!paint) drawSpotMarkers(ov);
  });
  ov.addEventListener("dblclick", (e) => e.stopPropagation());   // don't reset zoom
}

// Ask the server where to source a painted region from. It scores candidates
// around the region on the preview-size frame and we store the answer, so the
// render stays a pure function of the saved numbers — searching again at export
// resolution could pick a different area and disagree with the preview.
async function planPaint(p) {
  if (!S.editor) return null;
  const e = clone(curEdits());
  delete e.border;    // the overlay is drawn on the un-bordered frame
  try {
    const raw = rawRenderPath(editorPhoto());
    return await post("/api/plan-paint",
                      { path: raw || S.editor.path, pts: p.pts, r: p.r,
                        edits: e, full: !!raw });
  } catch (err) {
    return null;
  }
}

window.addEventListener("mousemove", (e) => {
  if (!paint) return;
  const ov = document.getElementById("spotOverlay");
  const f = S.viewer && S.viewer._fit[0];
  if (!ov || !f) return;
  if (Math.hypot(e.clientX - paint.ox, e.clientY - paint.oy) > 3) paint.moved = true;
  const r = ov.getBoundingClientRect();
  const [u, v] = paneToImg(f, e.clientX - r.left, e.clientY - r.top);
  if (paint.tool === "brush") {
    // thin the path out: dabs closer than a third of the brush add nothing but
    // work for the mask, and the server needs a path, not a mouse recording
    const last = paint.pts[paint.pts.length - 1];
    const short = Math.min(f.nw, f.nh);
    if (Math.hypot((u - last[0]) * f.nw / short, (v - last[1]) * f.nh / short) > paint.r / 3) {
      paint.pts.push([rnd5(u), rnd5(v)]);
    }
  } else {
    paint.src = [u, v];   // the spot tool drags out a source instead
  }
  drawSpotMarkers(ov);
});

window.addEventListener("mouseup", async () => {
  const p = paint;
  if (!p) return;
  paint = null;
  const f = S.viewer && S.viewer._fit[0];
  if (!f || !S.editor) return;
  const short = Math.min(f.nw, f.nh);

  let dx, dy;
  if (p.tool === "spot" && p.moved && p.src) {
    dx = p.src[0] - p.pts[0][0];
    dy = p.src[1] - p.pts[0][1];
    if (Math.hypot(dx * f.nw, dy * f.nh) < 2) {
      toast("Source and target overlap — drag further away");
      syncSpotOverlay();
      return;
    }
  } else {
    const plan = await planPaint(p);
    if (!S.editor) return;            // photo changed while we were asking
    if (plan) {
      dx = plan.dx; dy = plan.dy;
    } else {
      // nothing usable found: fall back to the area beside what was painted,
      // flipping sides when that would run off the frame
      const step = 2.6 * p.r * short / f.nw;
      const x = p.pts[0][0];
      dx = x + step < 1 ? step : -step;
      dy = 0;
    }
  }
  const n = clone(curEdits());
  n.spots = (n.spots || []).concat([
    { pts: p.pts, r: rnd5(p.r), dx: rnd5(dx), dy: rnd5(dy), mode: p.mode }]);
  pushEdit(n);
});

// ---------------------------------------------------------------------------
// Date split
// ---------------------------------------------------------------------------
function openSplit() {
  if (!S.folder) { toast("Open a folder first"); return; }
  $("spStatus").textContent = "";
  showModal("splitModal");
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
    hideModal("splitModal");
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

// Marking keys, which flank the ESDF nav cluster and work everywhere:
// W keep · R reject · Q clear flag · 1-5 stars · ` or 0 for no stars.
const MARKS = { w: { flag: 1 }, r: { flag: -1 }, q: { flag: 0 },
                "`": { rating: 0 }, "0": { rating: 0 } };

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
  // an open modal owns the keyboard: Esc closes it, nothing else gets through
  // to the grid (culling hotkeys must not fire at a photo you can't see)
  const modal = openModal();
  if (modal) {
    if (e.key === "Escape") hideModal(modal);
    return;
  }
  if (inField(e)) {
    if (e.key === "Escape") {
      // Esc must always get you out — otherwise a focused slider traps the
      // viewer. In the search box it clears the search first; a second press
      // then leaves the field like anywhere else.
      if (e.target === $("searchBox") && e.target.value) { setSearch(""); return; }
      e.target.blur();
      if (S.viewer) closeViewer();
    }
    return;
  }

  const k = e.key.toLowerCase();

  // While the folder tree is open it owns the keyboard, the way a modal does:
  // you are picking a folder, not culling, and the grid behind the drawer is
  // half-covered. Before this the panel could only be used with the mouse, and
  // Esc did nothing at all while it was up.
  if (!$("treePanel").classList.contains("hidden")) {
    if (k === "escape") { treeClose(); return; }
    if (treeKey(k)) e.preventDefault();
    return;
  }

  // "/" jumps to the filename filter, the way it does in every list that has
  // one. It has to come before the letter keys so the key itself isn't eaten.
  if (e.key === "/" && !S.viewer) { e.preventDefault(); $("searchBox").focus(); return; }

  const inViewer = !!S.viewer;
  // Shift aims a mark at the whole selection instead of the one photo under the
  // cursor. Shifted digits arrive as !@#$% rather than 1-5, so the rating keys
  // are read off the physical key.
  const bulk = e.shiftKey && S.compare.length > 0;
  const digit = /^Digit([1-5])$/.exec(e.code || "");

  // ---- marking: keys flanking the ESDF nav cluster, works everywhere ----
  if ((MARKS[k] || digit) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const fields = digit ? { rating: +digit[1] } : MARKS[k];
    if (bulk) markSelection(fields);
    else markCurrent(fields, fields.flag === 1 || fields.flag === -1);
    return;
  }
  if (k === "u") { undoMark(); return; }
  // Compare best-pick: in compare view with ≤3 images, S/D/F keep that pane,
  // reject the rest, and close. (Overrides compare nav/zoom for those keys.)
  if (S.viewer && S.viewer.mode === "compare" && S.viewer.paths.length <= 3) {
    const pi = PICK_KEYS.indexOf(k);
    if (pi >= 0 && pi < S.viewer.paths.length) { pickBest(pi); return; }
  }
  if (inViewer) {
    if (S.cropMode) {   // crop drag in progress swallows nav/zoom; Esc cancels it
      if (k === "escape") exitCropMode();
      return;
    }
    // retouch keeps nav and zoom live (you zoom in to place a spot), so Esc
    // leaves the mode first and only closes the viewer on a second press
    if (S.spotMode && k === "escape") { exitRetouch(); return; }
    if (k === "escape") { closeViewer(); return; }
    // the shortcut sheet is most wanted from in here, where half the keys live
    // — the viewer branch used to swallow V before the grid could act on it
    if (k === "v" || k === "?") { showModal("help"); return; }
    // editor shortcuts (loupe only): O original/edited, C crop, I info, G grid, H histogram
    if (S.viewer.mode === "loupe" && S.editor) {
      if (k === "o") { toggleOriginal(); return; }
      if (k === "c") { editAction("crop"); return; }
      if (k === "i") { toggleMeta(); return; }
      if (k === "g") { toggleGrid(); return; }
      if (k === "h") { toggleHist(); return; }
      if (k === "p") { toggleRetouch(); return; }
    }
    if (S.viewer.mode === "tournament") {
      switch (k) {
        case "arrowleft": case "s": tournamentVote("left"); return;
        case "arrowright": case "f": tournamentVote("right"); return;
        case "arrowup": case "e": case "+": case "=": zoomAtCenter(1.25); return;
        case "arrowdown": case "d": case "-": case "_": zoomAtCenter(0.8); return;
        case "z": zoomToggle(); return;
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
      case "z": zoomToggle(); return;
      case "l": if (S.viewer.mode === "loupe") toggleFilmstrip(); return;
      case " ": {
        const cp = currentPhoto();
        if (cp) { toggleCompare(cp.path); syncFilmstrip([cp.path]); }
        e.preventDefault(); return;
      }
      case "home": if (S.viewer.mode === "loupe") loupeGo(0); return;
      case "end": if (S.viewer.mode === "loupe") loupeGo(S.viewer.paths.length - 1); return;
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
    case "pageup": setCursor(S.cursor - cols * rowsPerScreen()); e.preventDefault(); return;
    case "pagedown": setCursor(S.cursor + cols * rowsPerScreen()); e.preventDefault(); return;
    case "c": openCompare(); return;
    case "a": toggleSelectAll(); e.preventDefault(); return;
    case "x": clearCompare("Selection cleared"); return;
    case "t": cycleFilter(); return;
    case "b": toggleMouseMode(); return;
    case "v": case "?": showModal("help"); return;
  }
});

function zoomAtCenter(factor) {
  const pane = panesEl.children[S.viewer.mode === "loupe" ? 0 : Math.max(0, S.viewer.cur)];
  if (!pane) return;
  const r = pane.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}

// Filename filter. Debounced by the caller, not here — this is also what Esc
// and the persisted value go through, and those want to take effect at once.
function setSearch(q) {
  q = (q || "").trim().toLowerCase();
  if (q === S.search) return;
  S.search = q;
  if ($("searchBox").value.trim().toLowerCase() !== q) $("searchBox").value = q;
  localStorage.setItem("search", q);
  applyFilter();
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
  $("exRun").disabled = true;

  const prog = $("exProgress");
  const bar  = $("exProgressBar");
  const lbl  = $("exProgressLabel");
  prog.classList.remove("hidden");
  bar.style.width = "0%";
  lbl.textContent = "";

  try {
    const resp = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dest,
        action: $("exAction").value,
        selection: $("exSel").value,
        paths: $("exSel").value === "selected" ? selectionPaths() : null,
        min_rating: parseInt($("exMin").value, 10),
        keep_structure: $("exStruct").checked,
        compress: $("exCompress").checked,
        quality: parseInt($("exQuality").value, 10),
        raw_jpeg: $("exRawJpeg").checked,
        raw_copy: $("exRawCopy").checked,
        raw_sidecar: $("exRawSidecar").checked,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || resp.statusText);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finalResult = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n\n");
      buf = lines.pop();   // keep incomplete tail
      for (const chunk of lines) {
        const line = chunk.trim();
        if (!line.startsWith("data:")) continue;
        const evt = JSON.parse(line.slice(5).trim());
        if (evt.type === "progress") {
          const pct = evt.total > 0 ? Math.round((evt.done / evt.total) * 100) : 0;
          bar.style.width = pct + "%";
          lbl.textContent = `${evt.done} / ${evt.total} — ${evt.name}`;
        } else if (evt.type === "done") {
          finalResult = evt;
          bar.style.width = "100%";
        }
      }
    }

    if (!finalResult) throw new Error("No response from server");
    const verb = finalResult.action === "move" ? "Moved" : "Copied";
    let msg = `${verb} ${finalResult.exported} files to ${finalResult.dest}`;
    if (finalResult.errors.length) msg += ` · ${finalResult.errors.length} errors`;
    $("exStatus").textContent = msg;
    lbl.textContent = "";
    renderExFiles(verb, finalResult.files, finalResult.errors);
    toast(`${verb} ${finalResult.exported} files`);
    reloadFolder();
  } catch (e) {
    $("exStatus").textContent = "Error: " + e.message;
    prog.classList.add("hidden");
  } finally {
    $("exRun").disabled = false;
  }
}

// list exactly which files landed (and any per-file errors)
function renderExFiles(verb, files, errors) {
  const el = $("exFiles");
  files = files || []; errors = errors || [];
  if (!files.length && !errors.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  let h = `<div class="exhead">${verb} ${files.length} file${files.length === 1 ? "" : "s"}:</div>`;
  h += files.map((f) => {
    const dest = escapeHtml(f.dest);
    return `<div class="exrow"><span class="exname">${escapeHtml(f.name)}</span>` +
      (f.compressed ? `<span class="excomp">compressed</span>` : "") +
      `<span class="expath" title="${dest}">${dest}</span></div>`;
  }).join("");
  if (errors.length) h += errors.map((e) => `<div class="exrow err">⚠ ${escapeHtml(e)}</div>`).join("");
  el.innerHTML = h;
  el.classList.remove("hidden");
}

function rejectedCount() { return visiblePhotos().filter((p) => p.flag === -1).length; }

// The selection holds one path per grid cell, but a cell can front a RAW+JPEG
// pair. Every other bulk action expands the group before acting; an export that
// didn't would quietly leave the negative behind while the RAW switches in the
// dialog sat there looking like they applied.
function selectionPaths() {
  const out = [];
  for (const pp of S.compare) {
    const p = S.byPath.get(pp);
    for (const m of (p && p.members && p.members.length ? p.members : [pp])) {
      if (!out.includes(m)) out.push(m);
    }
  }
  return out;
}

function defaultExportDest() {
  if (!S.folder) return "";
  const sep = S.folder.includes("\\") ? "\\" : "/";
  return S.folder.replace(/[\\/]+$/, "") + sep + "cull_output";
}

function openExport() {
  if (!$("exDest").value.trim()) $("exDest").value = defaultExportDest();
  // "the photos I picked" is only an option while there are some; when there
  // are, it is usually the one that was meant, so it is pre-chosen
  const selOpt = [...$("exSel").options].find((o) => o.value === "selected");
  const picked = S.compare.length;
  selOpt.textContent = picked ? `Selected in the grid (${picked})` : "Selected in the grid";
  selOpt.disabled = !picked;
  if (!picked && $("exSel").value === "selected") $("exSel").value = "keep";
  else if (picked && !$("exSel").dataset.touched) $("exSel").value = "selected";
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
  $("exProgress").classList.add("hidden");
  $("exProgressBar").style.width = "0%";
  $("exProgressLabel").textContent = "";
  // the RAW switches only mean anything if the library actually holds RAWs
  $("exRawBox").classList.toggle("hidden", !S.photos.some((p) => RAW_EXTS.has(p.ext)));
  showModal("exportModal");
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
      `<div class="del-name">${escapeHtml(p.filename)}</div>`;
    cell.addEventListener("click", () => toggleDelSelect(p.path, cell));
    frag.appendChild(cell);
  });
  g.appendChild(frag);

  updateDelCount();
  $("delStatus").textContent = "";
  hideModal("exportModal");
  showModal("deleteModal");
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
    hideModal("deleteModal");
    $("exStatus").textContent = msg;
    reloadFolder();  // refresh library
  } catch (e) {
    $("delStatus").textContent = "Error: " + e.message;
    if (/count changed/.test(e.message)) { hideModal("deleteModal"); reloadFolder(); }
  }
}

// ---------------------------------------------------------------------------
// Folder tree panel
// ---------------------------------------------------------------------------
const treeState = {
  selected: null,   // currently selected folder path
  current: null,    // path whose children are listed (null = roots)
};

function treeOpen() {
  $("treePanel").classList.remove("hidden");
  $("treeBtn").classList.add("active");
  // Start at current open folder's parent, or roots
  const start = S.folder ? getParentPath(S.folder) : null;
  treeNavigate(start, S.folder);
}

function treeClose() {
  $("treePanel").classList.add("hidden");
  $("treeBtn").classList.remove("active");
}

function getParentPath(p) {
  // Returns parent directory, or null if already a root
  const sep = p.includes("/") ? "/" : "\\";
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  if (parts.length <= 1) return null;
  // Windows drive root: "C:" → null
  if (/^[A-Za-z]:$/.test(parts[0]) && parts.length === 2) return null;
  parts.pop();
  const parent = parts.join(sep);
  // Handle Windows drive root like "C:"
  return parent || null;
}

function buildCrumb(path) {
  const crumb = $("treeCrumb");
  if (!path) { crumb.textContent = ""; return; }

  // Split into segments
  const norm = path.replace(/\\/g, "/");
  const parts = norm.replace(/\/$/, "").split("/").filter(Boolean);
  const sep = path.includes("\\") ? "\\" : "/";   // POSIX paths keep their "/"

  crumb.innerHTML = "";
  // Build cumulative paths
  let cumulative = [];
  // Windows: first part may be "C:" — restore backslash
  parts.forEach((seg, i) => {
    const isWinDrive = /^[A-Za-z]:$/.test(seg);
    if (i === 0 && isWinDrive) {
      cumulative.push(seg + "\\");
    } else if (i === 0) {
      cumulative.push(sep === "/" ? "/" + seg : seg);
    } else {
      const prev = cumulative[i - 1] || "";
      cumulative.push(prev.endsWith(sep) ? prev + seg : prev + sep + seg);
    }
    if (i > 0) {
      const s = document.createElement("span");
      s.className = "crumb-sep"; s.textContent = " › ";
      crumb.appendChild(s);
    }
    const a = document.createElement("span");
    a.className = "crumb-seg";
    a.textContent = isWinDrive ? seg + "\\" : seg;
    const target = cumulative[i];
    a.addEventListener("click", () => treeNavigate(getParentPath(target), target));
    crumb.appendChild(a);
  });
}

async function treeNavigate(parentPath, preselect) {
  treeState.current = parentPath || null;
  treeState.selected = preselect || null;
  buildCrumb(parentPath);
  updateTreeOpenBtn();

  const list = $("treeList");
  list.innerHTML = '<div class="tree-loading">Loading…</div>';

  const url = parentPath
    ? "/api/folder-tree?path=" + encodeURIComponent(parentPath)
    : "/api/folder-tree";
  try {
    const data = await api(url);
    renderTreeEntries(data.entries, preselect);
  } catch (e) {
    list.innerHTML = '<div class="tree-loading">Error loading folders</div>';
  }
}

function renderTreeEntries(entries, preselect) {
  const list = $("treeList");
  list.innerHTML = "";

  if (!treeState.current) {
    // At root level — no "go up" needed
  } else {
    // "Go up" row
    const up = document.createElement("div");
    up.className = "tree-item";
    up.innerHTML = '<span class="tree-icon">⬆</span><span class="tree-name" style="color:var(--muted)">.. (up)</span>';
    up.addEventListener("click", () => {
      const grandparent = getParentPath(treeState.current);
      treeNavigate(grandparent, treeState.current);
    });
    list.appendChild(up);
  }

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "tree-loading";
    empty.textContent = "No subfolders";
    list.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "tree-item" + (entry.path === preselect ? " selected" : "");
    row.dataset.path = entry.path;

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = "📁";

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;
    name.title = entry.path;

    row.appendChild(icon);
    row.appendChild(name);

    if (entry.has_children) {
      const arrow = document.createElement("span");
      arrow.className = "tree-arrow";
      arrow.textContent = "▶";
      arrow.title = "Browse into";
      arrow.addEventListener("click", (e) => {
        e.stopPropagation();
        treeNavigate(entry.path, entry.path);
      });
      row.appendChild(arrow);
    }

    row.addEventListener("click", () => treeSelectItem(entry.path, row));
    list.appendChild(row);
  }

  // Scroll selected item into view
  const sel = list.querySelector(".selected");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function treeSelectItem(path, rowEl) {
  // Deselect previous
  $("treeList").querySelectorAll(".tree-item.selected").forEach(el => el.classList.remove("selected"));
  rowEl.classList.add("selected");
  treeState.selected = path;
  buildCrumb(path);
  updateTreeOpenBtn();
}

function updateTreeOpenBtn() {
  $("treeOpenBtn").disabled = !treeState.selected;
}

// Keyboard driving for the tree: up/down move the highlight, right descends
// into the highlighted folder, left goes back up, Enter opens it as the
// library. Returns true when the key was ours, so the grid doesn't also act on
// it. Before this the panel could only be used with the mouse.
function treeKey(k) {
  const rows = [...$("treeList").querySelectorAll(".tree-item[data-path]")];
  if (!rows.length && k !== "arrowleft") return false;
  const at = rows.findIndex((r) => r.classList.contains("selected"));
  const go = (i) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (row) { treeSelectItem(row.dataset.path, row); row.scrollIntoView({ block: "nearest" }); }
  };
  switch (k) {
    case "arrowdown": case "d": go(at < 0 ? 0 : at + 1); return true;
    case "arrowup": case "e": go(at < 0 ? 0 : at - 1); return true;
    case "arrowright": case "f":
      if (treeState.selected) treeNavigate(treeState.selected, null);
      return true;
    case "arrowleft": case "s":
      treeNavigate(getParentPath(treeState.current || ""), treeState.current);
      return true;
    case "enter":
      if (treeState.selected) { scanFolder(treeState.selected); treeClose(); }
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
// A clicked button keeps keyboard focus, so the next Space or Enter presses it
// again instead of reaching the cull — click "Mouse" once and Space stops
// selecting photos. Focus goes back to the page after every press. Modals are
// left alone: tabbing through their fields is the one place it matters.
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("button");
  if (b && !b.closest(".modal")) b.blur();
});
$("treeBtn").addEventListener("click", () => {
  if ($("treePanel").classList.contains("hidden")) treeOpen(); else treeClose();
});
$("treePanelClose").addEventListener("click", treeClose);
$("treeOpenBtn").addEventListener("click", () => {
  if (treeState.selected) { scanFolder(treeState.selected); treeClose(); }
});
$("browseBtn").addEventListener("click", browseFolder);
$("reloadBtn").addEventListener("click", reloadFolder);
$("delRejected").addEventListener("click", openDeleteModal);
$("delCancel").addEventListener("click", () => hideModal("deleteModal"));
$("delConfirm").addEventListener("click", confirmDelete);
$("delSelectAll").addEventListener("click", () => delSetAll(true));
$("delSelectNone").addEventListener("click", () => delSetAll(false));
$("exBrowse").addEventListener("click", async () => {
  const folder = await pickFolder();
  if (folder) $("exDest").value = folder;
});
$("helpBtn").addEventListener("click", () => showModal("help"));
$("mouseBtn").addEventListener("click", () => toggleMouseMode());
$("helpClose").addEventListener("click", () => hideModal("help"));
$("filterSel").addEventListener("change", (e) => {
  S.filter = e.target.value; localStorage.setItem("filter", S.filter); applyFilter();
});
$("typeSel").addEventListener("change", (e) => {
  S.typeFilter = e.target.value; localStorage.setItem("typeFilter", S.typeFilter); applyFilter();
});
$("sortSel").addEventListener("change", (e) => {
  S.sortKey = e.target.value; localStorage.setItem("sortKey", S.sortKey); sortPhotos();
});
$("sortDir").addEventListener("click", () => {
  S.sortDir = -S.sortDir;
  localStorage.setItem("sortDir", String(S.sortDir));
  $("sortDir").textContent = S.sortDir === 1 ? "↑" : "↓";
  $("sortDir").title = S.sortDir === 1 ? "Sort ascending — click for descending"
                                       : "Sort descending — click for ascending";
  sortPhotos();
});

// ---- filename filter: keystrokes are debounced so a 3000-photo grid is not
// rebuilt on every letter, but the value itself is written through at once ----
let searchTimer = null;
$("searchBox").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => setSearch(v), 140);
});
$("searchBox").addEventListener("search", (e) => setSearch(e.target.value));

// ---- thumbnails: whole frame, or filled to the cell ----
function applyFitMode() {
  document.body.classList.toggle("fillthumbs", S.fillThumbs);
  const b = $("fitBtn");
  b.textContent = S.fillThumbs ? "▩ Fill" : "▣ Fit";
  b.title = S.fillThumbs
    ? "Thumbnails fill the cell (cropped) — click to show the whole frame"
    : "Thumbnails show the whole frame — click to fill the cell";
}
$("fitBtn").addEventListener("click", () => {
  S.fillThumbs = !S.fillThumbs;
  localStorage.setItem("fillThumbs", S.fillThumbs ? "1" : "0");
  applyFitMode();
});

// ---- loupe: edge chevrons, zoom toggle, filmstrip ----
$("loupePrev").addEventListener("click", () => { if (S.viewer) loupeGo(S.viewer.cur - 1); });
$("loupeNext").addEventListener("click", () => { if (S.viewer) loupeGo(S.viewer.cur + 1); });
$("zoomFitBtn").addEventListener("click", () => zoomToggle());
$("stripBtn").addEventListener("click", toggleFilmstrip);
$("groupRaw").addEventListener("change", (e) => {
  S.groupRaw = e.target.checked;
  localStorage.setItem("groupRaw", S.groupRaw ? "1" : "0");
  buildGroups();
  applyFilter();
});
$("exportBtn").addEventListener("click", openExport);
$("exCancel").addEventListener("click", () => hideModal("exportModal"));
$("exRun").addEventListener("click", runExport);
// ---- RAW export switches (persisted) ----
(function initRawExport() {
  for (const id of ["exRawJpeg", "exRawCopy", "exRawSidecar"]) {
    const box = $(id);
    const saved = localStorage.getItem(id);
    if (saved !== null) box.checked = saved === "1";
    box.addEventListener("change", () => {
      localStorage.setItem(id, box.checked ? "1" : "0");
      // asking the export for a JPEG off the negative is also a statement about
      // what you want to be looking at while you edit it
      if (id === "exRawJpeg" && box.checked) setPreviewSrc("raw");
    });
  }
})();

// once the user picks a "which", stop second-guessing them on later opens
$("exSel").addEventListener("change", () => { $("exSel").dataset.touched = "1"; });
$("exCompress").addEventListener("change", (e) => {
  document.querySelector(".exq").classList.toggle("hidden", !e.target.checked);
});

// ---- editor ----
$("editBar").addEventListener("click", (e) => {
  const chg = e.target.closest(".hchg.togglable");
  if (chg) { toggleEditKey(chg.dataset.key); return; }
  const head = e.target.closest(".ed-sec-head");
  if (head) { toggleSection(head.closest(".ed-section")); return; }
  const b = e.target.closest("button[data-act]");
  if (b) editAction(b.dataset.act);
});
$("sidebarToggle").addEventListener("click", toggleSidebar);
$("editBar").querySelectorAll("input[data-edit]").forEach((inp) => {
  inp.addEventListener("input", () => sliderInput(inp));
  inp.addEventListener("change", () => sliderCommit(inp));
  // reset to this slider's own neutral: 1 for the multipliers, 0 for WB
  inp.addEventListener("dblclick", () => {
    inp.value = neutralOf(inp.dataset.edit);
    sliderCommit(inp);
  });
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

// ---- retouch controls: brush size / heal-vs-clone / crop ratio, all remembered
// across sessions. None of them is part of the edit stack — they only decide
// what the next click produces. ----
(function initRetouchControls() {
  const size = $("spotSize"), num = $("spotSizeNum"), mode = $("spotModeSel"),
        tool = $("spotTool"), aspect = $("cropAspect");
  const savedSize = parseFloat(localStorage.getItem("spotSize") || "");
  if (savedSize >= +size.min && savedSize <= +size.max) size.value = savedSize;
  num.value = Math.round(size.value * 1000) / 10;
  const savedMode = localStorage.getItem("spotModeSel");
  if (savedMode === "heal" || savedMode === "clone") mode.value = savedMode;
  const savedAspect = localStorage.getItem("cropAspect");
  if (savedAspect !== null && [...aspect.options].some((o) => o.value === savedAspect)) {
    aspect.value = savedAspect;
  }
  size.addEventListener("input", () => {
    num.value = Math.round(size.value * 1000) / 10;
    localStorage.setItem("spotSize", size.value);
    refreshSpotBrush();
  });
  num.addEventListener("change", () => {
    let v = parseFloat(num.value);
    if (isNaN(v)) v = 3;
    v = Math.max(0.5, Math.min(15, v));
    num.value = v;
    size.value = v / 100;
    localStorage.setItem("spotSize", size.value);
    refreshSpotBrush();
    num.blur();
  });
  const savedTool = localStorage.getItem("spotTool");
  if (savedTool === "brush" || savedTool === "spot") tool.value = savedTool;
  mode.addEventListener("change", () => localStorage.setItem("spotModeSel", mode.value));
  tool.addEventListener("change", () => {
    localStorage.setItem("spotTool", tool.value);
    tool.blur();
  });
  aspect.addEventListener("change", () => {
    localStorage.setItem("cropAspect", aspect.value);
    aspect.blur();
  });
})();

// ---- grid-view: paste edits to the compare selection, apply a preset ----
$("pasteBtn").addEventListener("click", pasteEditsToSelection);
$("presetGridApply").addEventListener("click", applyPresetToSelection);
populatePresetSelects();
updatePasteBtn();

// ---- date split ----
$("splitBtn").addEventListener("click", openSplit);
$("spCancel").addEventListener("click", () => hideModal("splitModal"));
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

// ---- EXIF panel / alignment grid / filmstrip: on by default, persisted once
// toggled ----
(function initTogglePrefs() {
  const sm = localStorage.getItem("showMeta");
  if (sm !== null) S.showMeta = sm === "1";
  const sg = localStorage.getItem("showGrid");
  if (sg !== null) S.showGrid = sg === "1";
  const sh = localStorage.getItem("showHist");
  if (sh !== null) S.showHist = sh === "1";
  const ss = localStorage.getItem("showStrip");
  if (ss !== null) S.showStrip = ss === "1";
})();

// ---- how the grid is sorted, filtered and drawn is part of how someone works,
// so it comes back with them rather than resetting to filename-descending every
// time the app is opened ----
(function initViewPrefs() {
  const sk = localStorage.getItem("sortKey");
  if (sk && [...$("sortSel").options].some((o) => o.value === sk)) {
    S.sortKey = sk; $("sortSel").value = sk;
  }
  if (localStorage.getItem("sortDir") === "1") S.sortDir = 1;
  $("sortDir").textContent = S.sortDir === 1 ? "↑" : "↓";
  $("sortDir").title = S.sortDir === 1 ? "Sort ascending — click for descending"
                                       : "Sort descending — click for ascending";
  const f = localStorage.getItem("filter");
  if (f && [...$("filterSel").options].some((o) => o.value === f)) {
    S.filter = f; $("filterSel").value = f;
  }
  // the type filter is validated against the folder's actual extensions in
  // populateTypeFilter(), so it is only seeded here
  S.typeFilter = localStorage.getItem("typeFilter") || "all";
  S.search = (localStorage.getItem("search") || "").trim().toLowerCase();
  $("searchBox").value = S.search;
  S.fillThumbs = localStorage.getItem("fillThumbs") === "1";
  applyFitMode();
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
// the tonal/lens sliders fill their own ticks in buildSliders(); these three
// are hand-written in the markup because they have bespoke live handlers
(function initTicks() {
  fillTicks("ticksBorder", 0, 0.15, 16);
  fillTicks("ticksFine", -45, 45, 19);
  fillTicks("ticksSpot", 0.005, 0.15, 15);
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
toggleMouseMode(true, true);   // default on, without shouting about it at load
