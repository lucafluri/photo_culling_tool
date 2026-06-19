"""
Fast photo culling tool — backend.

A local web app: point it at a folder (optionally recursive), it scans for
images (JPEG/PNG/WebP + camera RAW + HEIC), generates cached thumbnails and
previews, and serves a keyboard-driven browser UI for fast culling.

Marks (keep/reject flag + 0-5 star rating) are stored non-destructively in a
SQLite DB keyed by absolute file path, so re-opening a folder restores them.
An explicit export step physically moves/copies files.

Run:  python app.py   (then open http://127.0.0.1:8000)
"""

import os
import io
import sys
import json
import hashlib
import shutil
import sqlite3
import threading
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import List

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from PIL import Image, ImageOps
import pillow_heif

pillow_heif.register_heif_opener()

try:
    import rawpy
    HAVE_RAWPY = True
except Exception:  # pragma: no cover - optional
    HAVE_RAWPY = False

try:
    from send2trash import send2trash
    HAVE_TRASH = True
except Exception:  # pragma: no cover - optional
    HAVE_TRASH = False

# ----------------------------------------------------------------------------
# Config / paths
# ----------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

APP_HOME = Path.home() / ".photo_culler"
CACHE_DIR = APP_HOME / "cache"
DB_PATH = APP_HOME / "culler.db"
APP_HOME.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

STD_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
HEIC_EXTS = {".heic", ".heif"}
RAW_EXTS = {
    ".cr2", ".cr3", ".nef", ".arw", ".raf", ".rw2", ".dng", ".orf",
    ".pef", ".srw", ".raw", ".kdc", ".dcr", ".nrw", ".sr2", ".srf",
    ".x3f", ".erf", ".mef", ".mos", ".mrw", ".3fr",
}
ALL_EXTS = STD_EXTS | HEIC_EXTS | RAW_EXTS

THUMB_SIZE = 480       # grid thumbnails (long edge, px)
PREVIEW_SIZE = 2400    # loupe/compare preview (long edge, px)

# Column list returned to the UI; one source so the two photo SELECTs can't drift.
PHOTO_COLS = "path, filename, folder, flag, rating, mtime, size, taken"

# Flag values: 1 = keep/pick, -1 = reject, 0 = none.

# ----------------------------------------------------------------------------
# Database
# ----------------------------------------------------------------------------

_db_lock = threading.Lock()


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS photos (
                path     TEXT PRIMARY KEY,
                folder   TEXT,
                filename TEXT,
                mtime    REAL,
                size     INTEGER,
                flag     INTEGER DEFAULT 0,
                rating   INTEGER DEFAULT 0,
                taken    REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
        # migrate older DBs that predate the `taken` column
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(photos)").fetchall()]
        if "taken" not in cols:
            conn.execute("ALTER TABLE photos ADD COLUMN taken REAL")


def set_setting(key, value):
    with _db_lock, db() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )


def get_setting(key, default=None):
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    return json.loads(row["value"])


# ----------------------------------------------------------------------------
# Image loading & caching
# ----------------------------------------------------------------------------

def _load_pil(path):
    """Return an oriented RGB PIL image for any supported format.

    For RAW we use the embedded JPEG/bitmap preview (fast); only fall back to a
    half-size decode when no preview exists.
    """
    ext = Path(path).suffix.lower()
    if ext in RAW_EXTS and HAVE_RAWPY:
        with rawpy.imread(path) as raw:
            img = None
            try:
                thumb = raw.extract_thumb()
                if thumb.format == rawpy.ThumbFormat.JPEG:
                    img = Image.open(io.BytesIO(thumb.data))
                elif thumb.format == rawpy.ThumbFormat.BITMAP:
                    img = Image.fromarray(thumb.data)
            except Exception:
                img = None
            if img is None:
                rgb = raw.postprocess(use_camera_wb=True, half_size=True)
                img = Image.fromarray(rgb)
    else:
        img = Image.open(path)

    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    return img


def capture_time(path, ext):
    """Best-effort EXIF capture time (epoch seconds), or None.

    RAW formats aren't reliably readable via Pillow, so we skip them and let the
    caller fall back to file mtime.
    """
    if ext in RAW_EXTS:
        return None
    try:
        with Image.open(path) as img:
            exif = img.getexif()
            dt = None
            try:
                sub = exif.get_ifd(0x8769)  # Exif sub-IFD
                if sub:
                    dt = sub.get(36867) or sub.get(36868)  # DateTimeOriginal / Digitized
            except Exception:
                pass
            if not dt:
                dt = exif.get(306)  # DateTime (IFD0)
            if dt:
                return datetime.strptime(str(dt).strip(), "%Y:%m:%d %H:%M:%S").timestamp()
    except Exception:
        return None
    return None


def _cache_file(path, mtime, size_tag):
    key = "{}|{}|{}".format(path, mtime, size_tag).encode("utf-8")
    h = hashlib.md5(key).hexdigest()
    return CACHE_DIR / "{}_{}.jpg".format(size_tag, h)


def get_rendered(path, long_edge, size_tag):
    """Generate (or fetch from cache) a JPEG resized to `long_edge`. Returns Path."""
    try:
        st = os.stat(path)
    except OSError:
        raise HTTPException(status_code=404, detail="file not found")
    out = _cache_file(path, st.st_mtime, size_tag)
    if out.exists():
        return out
    img = _load_pil(path)
    img.thumbnail((long_edge, long_edge), Image.LANCZOS)
    img.save(out, "JPEG", quality=86, optimize=True)
    return out


# ----------------------------------------------------------------------------
# Scanning
# ----------------------------------------------------------------------------

def scan_folder(folder, recursive):
    folder = os.path.abspath(folder)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=400, detail="not a folder: {}".format(folder))

    found = []
    if recursive:
        for root, _dirs, files in os.walk(folder):
            for f in files:
                if Path(f).suffix.lower() in ALL_EXTS:
                    found.append(os.path.join(root, f))
    else:
        for f in os.listdir(folder):
            full = os.path.join(folder, f)
            if os.path.isfile(full) and Path(f).suffix.lower() in ALL_EXTS:
                found.append(full)

    found.sort(key=lambda p: p.lower())

    # reuse cached capture time for files whose mtime is unchanged (avoids
    # re-reading EXIF on every rescan)
    with db() as conn:
        existing = {
            r["path"]: (r["mtime"], r["taken"])
            for r in conn.execute("SELECT path, mtime, taken FROM photos").fetchall()
        }

    with _db_lock, db() as conn:
        for full in found:
            try:
                st = os.stat(full)
            except OSError:
                continue
            ext = Path(full).suffix.lower()
            prev = existing.get(full)
            if prev and prev[0] == st.st_mtime and prev[1] is not None:
                taken = prev[1]
            else:
                taken = capture_time(full, ext)
            conn.execute(
                """
                INSERT INTO photos(path, folder, filename, mtime, size, flag, rating, taken)
                VALUES(?, ?, ?, ?, ?, 0, 0, ?)
                ON CONFLICT(path) DO UPDATE SET
                    folder=excluded.folder,
                    filename=excluded.filename,
                    mtime=excluded.mtime,
                    size=excluded.size,
                    taken=excluded.taken
                """,
                (full, folder, os.path.basename(full), st.st_mtime, st.st_size, taken),
            )

    set_setting("last_folder", folder)
    set_setting("last_recursive", bool(recursive))
    return list_photos(found)


def list_photos(paths):
    if not paths:
        return []
    out = []
    with db() as conn:
        for p in paths:
            row = conn.execute(
                f"SELECT {PHOTO_COLS} FROM photos WHERE path=?",
                (p,),
            ).fetchone()
            if row:
                out.append(dict(row))
    return out


# ----------------------------------------------------------------------------
# API models
# ----------------------------------------------------------------------------

class OpenReq(BaseModel):
    folder: str
    recursive: bool = True


class MarkReq(BaseModel):
    path: str
    flag: int = None     # 1 keep, -1 reject, 0 none
    rating: int = None   # 0..5


class DeleteReq(BaseModel):
    confirm: bool = False
    expected_count: int = -1   # client echoes the count it warned about; must match
    permanent: bool = False    # force permanent delete even if recycle bin available
    paths: List[str] = None    # explicit subset to delete; None = all rejected


class ExportReq(BaseModel):
    dest: str
    action: str = "copy"        # "copy" | "move"
    selection: str = "keep"     # "keep" | "reject" | "rated"
    min_rating: int = 1         # used when selection == "rated"
    keep_structure: bool = False


# ----------------------------------------------------------------------------
# App
# ----------------------------------------------------------------------------

app = FastAPI(title="Photo Culler")


@app.get("/", response_class=HTMLResponse)
def index():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")

    # Cache-bust the JS/CSS by file mtime so browsers never run a stale copy
    # after an update.
    def ver(name):
        try:
            return str(int((STATIC_DIR / name).stat().st_mtime))
        except OSError:
            return "0"

    html = html.replace("/static/styles.css", "/static/styles.css?v=" + ver("styles.css"))
    html = html.replace("/static/app.js", "/static/app.js?v=" + ver("app.js"))
    return html


@app.get("/api/state")
def api_state():
    folder = get_setting("last_folder")
    recursive = get_setting("last_recursive", True)
    photos = []
    if folder and os.path.isdir(folder):
        with db() as conn:
            rows = conn.execute(
                f"SELECT {PHOTO_COLS} FROM photos WHERE folder=? ORDER BY path",
                (os.path.abspath(folder),),
            ).fetchall()
        photos = [dict(r) for r in rows]
    return {"folder": folder, "recursive": recursive, "photos": photos,
            "have_rawpy": HAVE_RAWPY, "have_trash": HAVE_TRASH}


@app.get("/api/pick-folder")
def api_pick_folder():
    """Open a native OS folder-picker on the machine running the server.

    Works because this is a localhost app — the server and the user are the same
    box. Returns {"folder": <path>} or {"folder": null} if cancelled/unavailable.
    """
    last = get_setting("last_folder") or str(Path.home())
    result = {"folder": None}

    def run_dialog():
        try:
            import tkinter
            from tkinter import filedialog
            root = tkinter.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.askdirectory(
                initialdir=last, title="Choose a photo folder", mustexist=True
            )
            root.destroy()
            if chosen:
                result["folder"] = os.path.abspath(chosen)
        except Exception as e:  # noqa
            result["error"] = str(e)

    # tkinter must own its thread; give it a fresh one and wait.
    t = threading.Thread(target=run_dialog)
    t.start()
    t.join()
    if result.get("error"):
        raise HTTPException(status_code=500, detail="picker unavailable: " + result["error"])
    return result


@app.post("/api/open")
def api_open(req: OpenReq):
    photos = scan_folder(req.folder, req.recursive)
    return {"folder": os.path.abspath(req.folder), "recursive": req.recursive,
            "photos": photos}


@app.get("/api/thumb")
def api_thumb(path: str = Query(...)):
    f = get_rendered(path, THUMB_SIZE, "thumb")
    return FileResponse(f, media_type="image/jpeg")


@app.get("/api/preview")
def api_preview(path: str = Query(...)):
    f = get_rendered(path, PREVIEW_SIZE, "preview")
    return FileResponse(f, media_type="image/jpeg")


@app.post("/api/mark")
def api_mark(req: MarkReq):
    sets = []
    vals = []
    if req.flag is not None:
        sets.append("flag=?")
        vals.append(int(req.flag))
    if req.rating is not None:
        sets.append("rating=?")
        vals.append(max(0, min(5, int(req.rating))))
    if not sets:
        return {"ok": True}
    vals.append(req.path)
    with _db_lock, db() as conn:
        cur = conn.execute(
            "UPDATE photos SET {} WHERE path=?".format(", ".join(sets)), vals
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="unknown path")
    with db() as conn:
        row = conn.execute(
            "SELECT path, flag, rating FROM photos WHERE path=?", (req.path,)
        ).fetchone()
    return dict(row)


@app.post("/api/export")
def api_export(req: ExportReq):
    dest = os.path.abspath(req.dest)
    os.makedirs(dest, exist_ok=True)

    with db() as conn:
        if req.selection == "keep":
            rows = conn.execute("SELECT * FROM photos WHERE flag=1").fetchall()
        elif req.selection == "reject":
            rows = conn.execute("SELECT * FROM photos WHERE flag=-1").fetchall()
        elif req.selection == "rated":
            rows = conn.execute(
                "SELECT * FROM photos WHERE rating>=?", (int(req.min_rating),)
            ).fetchall()
        else:
            raise HTTPException(status_code=400, detail="bad selection")

    done = 0
    errors = []
    moved = []   # (old_path, new_path) for DB path fixups after a move
    for r in rows:
        src = r["path"]
        if not os.path.isfile(src):
            errors.append("missing: " + src)
            continue
        if req.keep_structure:
            rel = os.path.relpath(src, r["folder"])
            target = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
        else:
            target = os.path.join(dest, os.path.basename(src))
            # avoid clobbering same-named files
            base, ext = os.path.splitext(target)
            n = 1
            while os.path.exists(target):
                target = "{}_{}{}".format(base, n, ext)
                n += 1
        try:
            if req.action == "move":
                shutil.move(src, target)
                moved.append((src, os.path.abspath(target)))
            else:
                shutil.copy2(src, target)
            done += 1
        except Exception as e:  # noqa
            errors.append("{}: {}".format(src, e))

    # A move leaves the source path dangling — repoint each moved file's DB
    # record to its new location so marks survive and it isn't reported missing.
    if moved:
        with _db_lock, db() as conn:
            for old, new in moved:
                conn.execute("DELETE FROM photos WHERE path=?", (new,))
                conn.execute(
                    "UPDATE photos SET path=?, folder=?, filename=? WHERE path=?",
                    (new, os.path.dirname(new), os.path.basename(new), old),
                )

    return {"exported": done, "dest": dest, "errors": errors}


@app.post("/api/delete-rejected")
def api_delete_rejected(req: DeleteReq):
    with db() as conn:
        rows = conn.execute("SELECT path FROM photos WHERE flag=-1").fetchall()
    rejected = [r["path"] for r in rows]
    if req.paths is not None:
        # only ever delete files that are actually flagged reject, even if the
        # client sends a stale/larger list
        sel = set(req.paths)
        paths = [p for p in rejected if p in sel]
    else:
        paths = rejected
    count = len(paths)

    if not req.confirm:
        # dry run — tell the client what would happen so it can warn the user
        return {"deleted": 0, "would_delete": count,
                "method": "recycle_bin" if (HAVE_TRASH and not req.permanent) else "permanent",
                "errors": []}

    if req.expected_count != -1 and req.expected_count != count:
        raise HTTPException(
            status_code=409,
            detail="rejected count changed ({} now vs {} confirmed); reload and retry".format(
                count, req.expected_count),
        )

    use_trash = HAVE_TRASH and not req.permanent
    deleted = 0
    errors = []
    gone = []
    for p in paths:
        try:
            if os.path.isfile(p):
                if use_trash:
                    send2trash(os.path.abspath(p))
                else:
                    os.remove(p)
            deleted += 1
            gone.append(p)
        except Exception as e:  # noqa
            errors.append("{}: {}".format(p, e))

    if gone:
        with _db_lock, db() as conn:
            conn.executemany("DELETE FROM photos WHERE path=?", [(p,) for p in gone])

    return {"deleted": deleted, "method": "recycle_bin" if use_trash else "permanent",
            "errors": errors}


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def main():
    import uvicorn
    host = "127.0.0.1"
    port = 8000
    url = "http://{}:{}".format(host, port)
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print("Photo Culler running at " + url)
    uvicorn.run(app, host=host, port=port, log_level="warning")


init_db()

if __name__ == "__main__":
    main()
