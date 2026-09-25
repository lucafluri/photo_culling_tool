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
import math
import hashlib
import shutil
import socket
import sqlite3
import threading
import time
import webbrowser
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse,
                               StreamingResponse)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageOps, ImageEnhance, ImageFilter
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

# PHOTO_CULLER_HOME redirects the DB and cache — tests point it at a temp dir
# so they can never touch a real library.
APP_HOME = Path(os.environ.get("PHOTO_CULLER_HOME") or Path.home() / ".photo_culler")
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
CACHE_BUDGET = 2 * 1024 ** 3   # prune the render cache back to this at startup

# Bumped whenever the pipeline changes what a given edit stack looks like, so
# renders cached by an older version are never served as the current look.
RENDER_VERSION = 2

# Bumped when scanning learns to read more metadata (RAW capture times, say),
# so files scanned before that are read once more instead of never.
META_VERSION = 2

# Column list returned to the UI; one source so the two photo SELECTs can't drift.
PHOTO_COLS = "path, filename, folder, flag, rating, mtime, size, taken, edits"

# Flag values: 1 = keep/pick, -1 = reject, 0 = none.

# ----------------------------------------------------------------------------
# Database
# ----------------------------------------------------------------------------

_db_lock = threading.Lock()


@contextmanager
def db():
    """A connection that commits on a clean exit and always closes.

    sqlite3's own context manager commits but leaves the connection open, so
    every `with db() as conn` used to leak a handle until GC got round to it.
    """
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    # WAL (set once in init_db) lets thumbnail reads carry on while a mark is
    # written; NORMAL skips the fsync per mark that the default does in WAL mode
    conn.execute("PRAGMA synchronous=NORMAL")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
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
                taken    REAL,
                edits    TEXT,
                meta_v   INTEGER
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
        # migrate older DBs that predate later columns
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(photos)").fetchall()]
        if "taken" not in cols:
            conn.execute("ALTER TABLE photos ADD COLUMN taken REAL")
        if "edits" not in cols:
            conn.execute("ALTER TABLE photos ADD COLUMN edits TEXT")
        if "meta_v" not in cols:
            conn.execute("ALTER TABLE photos ADD COLUMN meta_v INTEGER")
        conn.execute("CREATE INDEX IF NOT EXISTS photos_folder ON photos(folder)")


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
# Image loading
# ----------------------------------------------------------------------------

def _is_raw(path):
    return HAVE_RAWPY and Path(path).suffix.lower() in RAW_EXTS


# EXIF orientation -> the transpose that undoes it (what ImageOps.exif_transpose
# does, applied by hand because a RAW's orientation doesn't live in its preview)
_TRANSPOSE = {
    2: Image.FLIP_LEFT_RIGHT, 3: Image.ROTATE_180, 4: Image.FLIP_TOP_BOTTOM,
    5: Image.TRANSPOSE, 6: Image.ROTATE_270, 7: Image.TRANSVERSE, 8: Image.ROTATE_90,
}
# libraw's `flip` for the negative, as the EXIF orientation meaning the same
_FLIP_TO_ORIENTATION = {3: 3, 5: 8, 6: 6}


def _orientation(img):
    try:
        return int(img.getexif().get(0x0112) or 1)
    except Exception:
        return 1


def _open_source(path):
    """The picture a render of `path` starts from, not yet decoded.

    Returns (image, orientation). For a RAW that is its embedded camera JPEG —
    which is why a 2000-shot RAW folder opens in seconds. The preview inside a
    RAW usually carries no orientation of its own (it lives in the RAW's
    header), so libraw's is used: without it a portrait RAW came up sideways,
    and a crop drawn on it landed rotated on the full decode an export uses.
    A preview that is already portrait on a landscape sensor was rotated by
    the camera and is left alone.

    Nothing is decoded yet, so the caller can still ask the JPEG decoder for
    a reduced size — which is most of what a thumbnail costs.
    """
    if _is_raw(path):
        with rawpy.imread(path) as raw:
            sw, sh, flip = raw.sizes.width, raw.sizes.height, raw.sizes.flip
            thumb = None
            try:
                thumb = raw.extract_thumb()
            except Exception:
                thumb = None
            if thumb is None or thumb.format not in (rawpy.ThumbFormat.JPEG,
                                                     rawpy.ThumbFormat.BITMAP):
                # no usable preview: a half-size decode, which libraw orients
                rgb = raw.postprocess(use_camera_wb=True, half_size=True)
                return Image.fromarray(rgb), 1
        if thumb.format == rawpy.ThumbFormat.JPEG:
            img = Image.open(io.BytesIO(thumb.data))
        else:
            img = Image.fromarray(thumb.data)
        o = _orientation(img)
        w, h = img.size
        if o == 1 and flip in _FLIP_TO_ORIENTATION and (w >= h) == (sw >= sh):
            o = _FLIP_TO_ORIENTATION[flip]
        return img, o
    img = Image.open(path)
    return img, _orientation(img)


def _oriented_size(size, orientation):
    w, h = size
    return (h, w) if orientation in (5, 6, 7, 8) else (w, h)


def _to_rgb(img):
    """RGB, without the surprises a bare convert("RGB") has.

    Transparency goes onto white instead of whatever colour sat under it, and
    16-bit greyscale is scaled down rather than clipped (a straight convert
    turns everything above level 255 — nearly the whole picture — white).
    """
    if img.mode == "RGB":
        return img
    if img.mode.startswith("I;16") or img.mode == "I":
        return img.convert("I").point(lambda v: v * (1 / 256.0)).convert("L").convert("RGB")
    if img.mode in ("RGBA", "LA", "PA", "La") or (
            img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        out = Image.new("RGB", rgba.size, (255, 255, 255))
        out.paste(rgba, mask=rgba.getchannel("A"))
        return out
    return img.convert("RGB")


def _decode(path, long_edge=None):
    """Oriented RGB pixels of `path`, reduced to `long_edge` when given.

    Returns (image, icc_profile, full_size) where full_size is the oriented
    size at full resolution. A JPEG (the embedded preview of a RAW included)
    is decoded straight at 1/2, 1/4 or 1/8 scale when that still covers
    `long_edge`: the DCT does the downscale, so a 24MP thumbnail costs a tenth
    of a full decode.
    """
    img, o = _open_source(path)
    icc = img.info.get("icc_profile")
    full_size = _oriented_size(img.size, o)
    if long_edge:
        w, h = img.size
        L = max(w, h)
        if L > long_edge:
            try:
                img.draft(None, (max(1, -(-w * long_edge // L)), max(1, -(-h * long_edge // L))))
            except Exception:
                pass
    img = _to_rgb(img)
    method = _TRANSPOSE.get(o)
    if method is not None:
        img = img.transpose(method)
    if long_edge and max(img.size) > long_edge:
        img = _fit(img, long_edge)
    return img, icc, full_size


def _fit(img, long_edge):
    """A new image scaled down so its long edge is `long_edge` (never up)."""
    w, h = img.size
    L = max(w, h)
    if L <= long_edge:
        return img.copy()
    size = (max(1, round(w * long_edge / L)), max(1, round(h * long_edge / L)))
    return img.resize(size, Image.LANCZOS, reducing_gap=3.0)


def _raw_size(path):
    """Oriented size of a RAW's full decode. libraw reads it from the header."""
    with rawpy.imread(path) as raw:
        w, h = raw.sizes.width, raw.sizes.height
        return (h, w) if raw.sizes.flip in (5, 6) else (w, h)


def _load_raw_full(path, half=False):
    """Demosaic a RAW, oriented, as RGB. `half` skips interpolation entirely
    (each 2x2 sensor block becomes one pixel) — six times faster, and at the
    preview size the loupe draws it is the same picture.

    `_decode` deliberately reads the embedded preview — that is what makes a
    2000-shot RAW folder open in seconds — but the preview is a camera JPEG,
    smaller than the sensor and already cooked by the camera. When the point
    is "the good version off the negative", decode properly.
    """
    if not _is_raw(path):
        return _decode(path)[0]   # `full=1` asked for on a JPEG — nothing to demosaic
    with rawpy.imread(path) as raw:
        rgb = raw.postprocess(use_camera_wb=True, output_bps=8, half_size=half)
    img = Image.fromarray(rgb)
    return img if img.mode == "RGB" else img.convert("RGB")


def _exif_of(path):
    """The EXIF block of `path`, or None. Pillow parses the TIFF container most
    RAW formats use (CR2, NEF, ARW, DNG…); the rest fall back to the EXIF of
    their embedded preview, which is where Fuji and Canon's CR3 keep it."""
    try:
        with Image.open(path) as im:
            ex = im.getexif()
            if ex and (ex.get(271) or ex.get(0x8769)):
                ex.get_ifd(0x8769)      # pull the sub-IFDs in while the file is open
                ex.get_ifd(0x8825)
                return ex
    except Exception:
        pass
    if _is_raw(path):
        try:
            img, _o = _open_source(path)
            ex = img.getexif()
            if ex:
                ex.get_ifd(0x8769)
                ex.get_ifd(0x8825)
                return ex
        except Exception:
            pass
    return None


def capture_time(path, ext=None):
    """Best-effort EXIF capture time (epoch seconds), or None."""
    ex = _exif_of(path)
    if not ex:
        return None
    dt = None
    try:
        sub = ex.get_ifd(0x8769)
        if sub:
            dt = sub.get(36867) or sub.get(36868)  # DateTimeOriginal / Digitized
    except Exception:
        pass
    if not dt:
        dt = ex.get(306)  # DateTime (IFD0)
    try:
        return datetime.strptime(str(dt).strip().rstrip("\x00"), "%Y:%m:%d %H:%M:%S").timestamp()
    except (TypeError, ValueError):
        return None


# IFD0 tags worth carrying into a rendered JPEG. A RAW's IFD0 also describes
# the RAW's own strips and DNG colour matrices, which mean nothing in a JPEG.
_EXIF_KEEP = (270, 271, 272, 282, 283, 296, 305, 306, 315, 33432)


def _render_exif(size, sources):
    """EXIF bytes for a JPEG rendered at `size` from the first of `sources`
    that has any, or None.

    Orientation is dropped (it is baked into the pixels, and viewers would
    rotate the picture a second time), the pixel size is set to what was
    actually written, and there is no embedded thumbnail — it would show the
    unedited original in any viewer that trusts it.
    """
    for src in sources:
        ex = _exif_of(src) if src else None
        if not ex:
            continue
        out = Image.Exif()
        for tag in _EXIF_KEEP:
            if tag in ex:
                out[tag] = ex[tag]
        sub = dict(ex.get_ifd(0x8769) or {})
        sub.pop(0xA005, None)        # interop pointer: an offset into the old file
        if sub:
            sub[0xA002], sub[0xA003] = int(size[0]), int(size[1])
            out[0x8769] = sub
        gps = ex.get_ifd(0x8825)
        if gps:
            out[0x8825] = dict(gps)
        for drop_makernote in (False, True):
            if drop_makernote and 0x8769 in out:
                sub.pop(0x927C, None)
                out[0x8769] = sub
            try:
                data = out.tobytes()
            except Exception:
                return None
            if len(data) < 65000:    # a JPEG APP1 segment tops out at 64K
                return data
        return None
    return None


def _compress_jpeg(src, target, quality):
    """Re-encode a JPEG at `quality`, preserving EXIF/ICC (and thus orientation).

    Pixels are decoded and re-saved (smaller file), but no edits/transpose are
    applied — same image, lighter.
    """
    with Image.open(src) as im:
        exif = im.info.get("exif")
        icc = im.info.get("icc_profile")
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        kw = {"quality": quality, "optimize": True}
        if exif:
            kw["exif"] = exif
        if icc:
            kw["icc_profile"] = icc
        im.save(target, "JPEG", **kw)


def _bake_to_jpeg(src, target, edits, quality, raw_full=False, exif_from=()):
    """Render `src` with `edits` baked in and write a JPEG to `target`.

    Used by export and save-copy, so the file matches the edited preview: the
    same pipeline at full resolution, with `unit` telling the pixel-sized
    filters how much bigger than the preview this render is.

    EXIF and the colour profile are taken from the source before any edit
    runs. They used to be read off the edited image, and several stages
    (brightness, contrast) build a fresh image — so an export with those on
    silently lost its EXIF and, worse, its ICC profile, which turns an Adobe
    RGB photo into a dull sRGB one. `exif_from` lists fallbacks (the JPEG
    beside a RAW) for sources that carry none of their own.
    """
    if raw_full and _is_raw(src):
        img, icc = _load_raw_full(src), None      # libraw renders to sRGB
    else:
        img, icc, _full = _decode(src)
    unit = max(img.size) / float(min(max(img.size), PREVIEW_SIZE))
    img = _apply_edits(img, edits, unit)
    kw = {"quality": quality, "optimize": True}
    exif = _render_exif(img.size, (src,) + tuple(exif_from))
    if exif:
        kw["exif"] = exif
    if icc:
        kw["icc_profile"] = icc
    img.save(target, "JPEG", **kw)


_XMP = """<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:culler="https://photo-culler.local/ns/1.0/"
    xmp:Rating="{rating}"
    xmp:Label="{label}"
    culler:Edits="{edits}"
    culler:Changes="{changes}" />
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"""


def _describe_edits(edits):
    """Short human-readable list of what the edit stack does, for the sidecar."""
    if not edits:
        return "none"
    out = []
    for key, val in sorted(edits.items()):
        if key == "off":            # parked adjustments aren't applied
            continue
        if key == "border":
            out.append("border {:.0%}".format(float(val.get("w", 0) or 0)))
        elif key == "crop":
            out.append("cropped")
        elif key == "spots":
            out.append("retouch {} spot(s)".format(len(val or ())))
        elif isinstance(val, bool):
            if val:
                out.append(key)
        else:
            out.append("{} {}".format(key, val))
    return ", ".join(out)


def _write_xmp_sidecar(target, edits, rating, flag):
    """Write `<target>.xmp` beside an exported RAW.

    A RAW cannot carry baked pixels, so "export the RAW with my changes" means
    the negative plus a record of the changes. The rating and keep/reject label
    go in standard XMP so other software reads them; the edit stack goes in our
    own namespace, which is the only place it could be round-tripped from.
    """
    from xml.sax.saxutils import escape
    edits = applied_edits(edits)      # parked adjustments are not changes
    body = _XMP.format(
        rating=int(rating or 0),
        label={1: "Keep", -1: "Reject"}.get(int(flag or 0), ""),
        edits=escape(json.dumps(edits or {}, sort_keys=True), {'"': "&quot;"}),
        changes=escape(_describe_edits(edits), {'"': "&quot;"}),
    )
    path = target + ".xmp"
    with io.open(path, "w", encoding="utf-8") as fh:
        fh.write(body)
    return path


def _max_inscribed(w, h, angle):
    """Largest axis-aligned rectangle inside a w×h rect rotated by `angle` (rad)."""
    if w <= 0 or h <= 0:
        return 0.0, 0.0
    width_is_longer = w >= h
    side_long, side_short = (w, h) if width_is_longer else (h, w)
    sin_a, cos_a = abs(math.sin(angle)), abs(math.cos(angle))
    if side_short <= 2.0 * sin_a * cos_a * side_long or abs(sin_a - cos_a) < 1e-10:
        # half-constrained case: two crop corners touch the long side
        x = 0.5 * side_short
        wr, hr = (x / sin_a, x / cos_a) if width_is_longer else (x / cos_a, x / sin_a)
    else:
        cos_2a = cos_a * cos_a - sin_a * sin_a
        wr = (w * cos_a - h * sin_a) / cos_2a
        hr = (h * cos_a - w * sin_a) / cos_2a
    return wr, hr


# ----------------------------------------------------------------------------
# Edit pipeline pieces
#
# Everything below takes a PIL image and returns a new one — `_apply_edits`
# must never mutate its input, because the live-preview base cache hands the
# same image object to every request for that photo.
# ----------------------------------------------------------------------------

def _f(edits, key, default=0.0):
    """Float out of the edits dict, tolerating nulls and strings from JSON."""
    try:
        v = edits.get(key)
        return default if v is None else float(v)
    except (TypeError, ValueError):
        return default


def _tone_lut(exposure, hi, sh, wh, bl):
    """256-entry curve for exposure + highlights/shadows/whites/blacks.

    One lookup table instead of four passes: these are all per-pixel tone moves,
    so they compose into a single curve that PIL applies in C. Highlights and
    shadows use bell masks that vanish at both ends (so pure black stays black);
    whites and blacks push the ends themselves. Exposure is a linear-light
    multiply, which is what makes it read as stops rather than as brightness.
    """
    lut = []
    for i in range(256):
        v = i / 255.0
        if exposure:
            lin = (v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
            lin = min(1.0, max(0.0, lin * (2.0 ** exposure)))
            v = (lin * 12.92) if lin <= 0.0031308 else (1.055 * lin ** (1 / 2.4) - 0.055)
        v0, out = v, v
        if sh:
            out += 0.40 * sh * 4.0 * v0 * (1 - v0) ** 2
        if hi:
            out += 0.40 * hi * 4.0 * (1 - v0) * v0 ** 2
        if bl:
            out += 0.25 * bl * (1 - v0) ** 2
        if wh:
            out += 0.25 * wh * v0 ** 2
        lut.append(int(round(min(1.0, max(0.0, out)) * 255)))
    return lut


def _clip8(v):
    return 0 if v <= 0 else (255 if v >= 255 else int(v))


def _tone_chain(img, edits):
    """Tone curve, auto-levels, white balance, brightness and contrast.

    All of them are per-channel tone moves, so they compose into one 768-entry
    lookup table and a single pass over the pixels — they used to be five
    passes, two of which built a full-size helper image. The table reproduces
    each step as PIL computed it (white balance truncates, brightness and
    contrast blend like ImageEnhance, contrast pivots on the mean luminance of
    the picture as it stands at that point), so the result is the same as the
    step-by-step version. Auto-levels needs the histogram after the tone curve
    and is the one step that still runs on its own.
    """
    exposure = _f(edits, "exposure")
    hi, sh = _f(edits, "highlights"), _f(edits, "shadows")
    wh, bl = _f(edits, "whites"), _f(edits, "blacks")
    lut = _tone_lut(exposure, hi, sh, wh, bl) if (exposure or hi or sh or wh or bl) else None
    if edits.get("auto"):
        # auto-levels: stretch the histogram, clipping 1% outliers per channel
        if lut:
            img = img.point(lut * 3)
            lut = None
        img = ImageOps.autocontrast(img, cutoff=1)
    # full white balance: independent +/- gain on red and blue. `temp` is the
    # older single-axis control (kept so photos edited before the R/B split
    # still render the same) — it nudges both channels oppositely, as before;
    # wbR/wbB move independently on top of that.
    temp = _f(edits, "temp")
    wb_r, wb_b = _f(edits, "wbR"), _f(edits, "wbB")
    gains = (1 + 0.3 * (temp + wb_r), 1.0, 1 + 0.3 * (-temp + wb_b))
    bright = _f(edits, "bright", 1.0)
    contrast = _f(edits, "contrast", 1.0)
    if lut is None and gains == (1.0, 1.0, 1.0) and bright == 1 and contrast == 1:
        return img
    base = lut or list(range(256))
    chans = []
    for g in gains:
        ch = [min(255, int(v * g)) for v in base] if g != 1 else list(base)
        if bright != 1:
            ch = [_clip8(v * bright) for v in ch]
        chans.append(ch)
    if contrast != 1:
        # the mean luminance after the steps above, from the histogram rather
        # than from a converted copy of the picture
        hist = img.histogram()
        n = float(img.size[0] * img.size[1]) or 1.0
        means = [sum(c * v for c, v in zip(hist[256 * k:256 * k + 256], chans[k])) / n
                 for k in range(3)]
        mean = int(0.299 * means[0] + 0.587 * means[1] + 0.114 * means[2] + 0.5)
        chans = [[_clip8(mean + contrast * v - contrast * mean) for v in ch] for ch in chans]
    return img.point(chans[0] + chans[1] + chans[2])


# 255 x lo/hi for every (lo, hi) pair of 8-bit values, indexed by lo << 8 | hi
_VIB_TABLE = np.clip(np.arange(256)[:, None] * 255.0 / np.maximum(np.arange(256), 1)[None, :]
                     + 0.5, 0, 255).astype(np.uint8).ravel()


def _vibrance_mask(img):
    """255 x (min/max channel) per pixel: 255 for grey, 0 for a pure hue."""
    r, g, b = img.split()
    lo = np.asarray(ImageChops.darker(ImageChops.darker(r, g), b))
    hi = np.asarray(ImageChops.lighter(ImageChops.lighter(r, g), b))
    idx = lo.astype(np.uint16) << 8
    idx |= hi
    return Image.fromarray(_VIB_TABLE[idx])


def _saturate(img, vib, sat):
    """Vibrance and saturation in one go.

    Vibrance is saturation weighted by how unsaturated a pixel already is, so
    skin and other already-saturated colours barely move. Both scale a pixel's
    distance from its own grey, so the pair is one blend between two plainly
    saturated copies, picked per pixel by that weight — all in C, where the
    old numpy version spent five seconds on a 24MP frame.
    """
    if not vib and sat == 1:
        return img
    enh = ImageEnhance.Color(img)
    lo = enh.enhance(sat)
    if not vib:
        return lo
    return Image.composite(enh.enhance(sat * (1.0 + vib)), lo, _vibrance_mask(img))


def _wide_blur(img, radius):
    """Gaussian blur, computed at reduced size when the radius is large.

    A blur tens of pixels wide has no fine detail left in it, so it can be
    worked out on a copy an eighth of the size and scaled back up — the same
    picture at a fraction of the cost.
    """
    k = int(radius / 3.0)
    if k < 2:
        return img.filter(ImageFilter.GaussianBlur(radius))
    W, H = img.size
    small = img.reduce(k).filter(ImageFilter.GaussianBlur(radius / k))
    return small.resize((W, H), Image.BILINEAR, box=(0, 0, W / float(k), H / float(k)))


def _unsharp(img, blur, amount, threshold=0):
    """img + amount x (img - blur), leaving differences under `threshold` alone.

    PIL's UnsharpMask does the same but insists on computing its own blur;
    taking it as an argument lets a wide one come from `_wide_blur`.
    """
    diff = ImageChops.subtract(img, blur, 1.0, 128)
    lut = [128 if abs(d - 128) < threshold else _clip8(128 + amount * (d - 128) + 0.5)
           for d in range(256)]
    return ImageChops.add(img, diff.point(lut * 3), 1.0, -128)


def _denoise(img, amt, unit):
    """Edge-aware smoothing.

    A blur is blended in where the picture differs little from it — noise —
    and kept out where it differs a lot — edges and texture. The blur is sized
    in reference pixels, so a preview and a full-size export smooth the same
    features; the median filter this replaces worked on raw pixels, which made
    the preview look far stronger than the export (and took 8 s at 24MP).
    """
    amt = min(1.0, amt)
    blur = img.filter(ImageFilter.GaussianBlur(unit * (0.6 + 1.4 * amt)))
    diff = ImageChops.difference(img, blur).convert("L")
    t = 6.0 + 30.0 * amt
    mask = diff.point([int(255 * amt * max(0.0, 1.0 - d / t)) for d in range(256)])
    return Image.composite(blur, img, mask)


def _vignette(img, amt):
    """Radial gain. Positive darkens the corners, negative corrects lens falloff.

    The gain map is built row-band by row-band as 8-bit and applied with
    PIL's multiply, so the frame itself never becomes a float array.
    """
    W, H = img.size
    cx, cy = (W - 1) / 2.0, (H - 1) / 2.0
    rx, ry = max(cx, 1e-6), max(cy, 1e-6)
    fx = (((np.arange(W, dtype=np.float32) - cx) / rx) ** 2 / 2.0)[None, :]
    fy = (((np.arange(H, dtype=np.float32) - cy) / ry) ** 2 / 2.0)[:, None]
    mask = np.empty((H, W), np.uint8)
    for y in range(0, H, 1024):
        d2 = fy[y:y + 1024] + fx                         # 0 centre, 1 corner
        g = (1.0 - amt * d2) if amt > 0 else (-amt * d2)
        mask[y:y + 1024] = np.clip(g * 255.0 + 0.5, 0, 255)
    m = Image.fromarray(mask)
    m3 = Image.merge("RGB", (m, m, m))
    if amt > 0:
        return ImageChops.multiply(img, m3)
    return ImageChops.add(img, ImageChops.multiply(img, m3))   # gain 1 + |amt| x d2


def _grain(img, amt, unit):
    """Monochrome gaussian grain, the same grain at any resolution.

    The noise lives on a grid of reference pixels and is resampled to the
    render: a preview draws it pixel for pixel, a full-size export stretches
    the same grid over its larger frame, and a thumbnail averages it down —
    so all three carry one grain pattern, at one strength, and the export
    downsized is the preview. It is seeded, so the same edits always render
    the same bytes — an unseeded rng would make every cache render a
    different picture.
    """
    W, H = img.size
    gw, gh = max(1, int(round(W / unit))), max(1, int(round(H / unit)))
    if gw > 8192 or gh > 8192:          # a unit that small can only be a bad call
        gw, gh = W, H
    noise = np.random.default_rng(9781).standard_normal((gh, gw), dtype=np.float32)
    n = Image.fromarray(np.clip(noise * (26.0 * amt) + 128.5, 0, 255).astype(np.uint8))
    if (gw, gh) != (W, H):
        n = n.resize((W, H), Image.BICUBIC if gw < W else Image.BOX)
    return ImageChops.add(img, Image.merge("RGB", (n, n, n)), 1.0, -128)


def _persp_coeffs(W, H, pv, ph):
    """PERSPECTIVE coefficients mapping the output frame onto the keystone
    quad inside the source.

    The output is the full frame and the *source* quad is a trapezoid inside
    the image, so every output pixel samples real pixels — the converging
    edge gets stretched back out instead of leaving empty corners behind.
    """
    tv, th = 0.25 * W * pv, 0.25 * H * ph
    top, bot = max(0.0, tv), max(0.0, -tv)
    lef, rig = max(0.0, th), max(0.0, -th)
    dst = [(0, 0), (W, 0), (W, H), (0, H)]
    src = [(top, lef), (W - top, rig), (W - bot, H - rig), (bot, H - lef)]
    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    try:
        return np.linalg.solve(np.array(A, np.float64), np.array(B, np.float64))
    except np.linalg.LinAlgError:
        return None


def _frame(w, h, edits):
    """Where the geometric edits leave the frame, without touching pixels.

    For a w x h oriented source: the size after the 90° steps, the size of
    the straightened frame (the largest upright rectangle inside the tilted
    picture), and the crop box inside that, in integer pixels.
    """
    rot = int(_f(edits, "rot")) % 360
    if rot in (90, 270):
        w, h = h, w
    fw, fh = w, h
    fine = _f(edits, "fine")
    if fine:
        wr, hr = _max_inscribed(w, h, math.radians(fine))
        fw, fh = max(1, min(w, int(wr))), max(1, min(h, int(hr)))
    box = (0, 0, fw, fh)
    crop = _crop_of(edits)
    if crop:
        l, t, r, b = crop
        cb = (int(l * fw), int(t * fh), int(r * fw), int(b * fh))
        if cb[2] > cb[0] and cb[3] > cb[1]:
            box = cb
    return (w, h), (fw, fh), box


def _crop_of(edits):
    """The crop as (l, t, r, b) fractions clamped to the frame, or None."""
    crop = edits.get("crop")
    if not crop or len(crop) != 4:
        return None
    try:
        l, t, r, b = (min(1.0, max(0.0, float(c))) for c in crop)
    except (TypeError, ValueError):
        return None
    return (l, t, r, b) if r > l and b > t else None


def _frame_zoom(w, h, edits):
    """How many times longer the source's long edge is than the edited frame's
    — how much resolution a crop or a straighten throws away."""
    _rot, _fr, box = _frame(w, h, edits or {})
    return max(w, h) / float(max(1, box[2] - box[0], box[3] - box[1]))


def _warp(img, edits):
    """Lens corrections, keystone, straighten and crop as one resampling.

    Each of these is a map from output pixels back to source pixels, so they
    compose: every output pixel is traced back through the crop, the
    straighten rotation, the keystone, the lateral CA and the distortion to
    the one place in the source it comes from, and the picture is resampled
    once. They used to be four full-frame resamples in a row — each softening
    the picture a little more, each warping pixels the crop then threw away.

    The trace is evaluated on a mesh of points ~48px apart and PIL
    interpolates inside each cell; all these maps are smooth, and the
    rotation and crop are exact. The crop and the straightened frame are
    kept fractional here: snapping them to whole pixels picked a slightly
    different window at every resolution, so a preview and its export were
    framed a fraction of a pixel apart.
    """
    W, H = img.size
    fine = _f(edits, "fine")
    fw, fh = float(W), float(H)
    if fine:
        wr, hr = _max_inscribed(W, H, math.radians(fine))
        fw, fh = min(fw, wr), min(fh, hr)
    l, t, r, b = _crop_of(edits) or (0.0, 0.0, 1.0, 1.0)
    cw = max(1, int(round((r - l) * fw)))
    ch = max(1, int(round((b - t) * fh)))
    xs = np.round(np.linspace(0, cw, max(2, min(64, -(-cw // 48))) + 1)).astype(np.int64)
    ys = np.round(np.linspace(0, ch, max(2, min(64, -(-ch // 48))) + 1)).astype(np.int64)
    X, Y = np.meshgrid(l * fw + xs * ((r - l) * fw / cw), t * fh + ys * ((b - t) * fh / ch))

    if fine:
        # the inverse of img.rotate(-fine, expand=True) about the centre
        th = math.radians(fine)
        c, s = math.cos(th), math.sin(th)
        dx, dy = X - fw / 2.0, Y - fh / 2.0
        X, Y = W / 2.0 + c * dx + s * dy, H / 2.0 - s * dx + c * dy
    pv, ph = _f(edits, "persV"), _f(edits, "persH")
    if pv or ph:
        co = _persp_coeffs(W, H, pv, ph)
        if co is not None:
            a, b, c, d, e, f, g, h = co
            den = g * X + h * Y + 1.0
            X, Y = (a * X + b * Y + c) / den, (d * X + e * Y + f) / den
    ca = _f(edits, "ca")
    k = _f(edits, "distort")
    # lateral CA: red and blue are scaled against green about the centre
    scales = (1.0 + 0.003 * ca, 1.0, 1.0 - 0.003 * ca) if ca else (1.0,)
    half = math.hypot(W, H) / 2.0
    meshes = []
    for sc in scales:
        Xs, Ys = X, Y
        if sc != 1.0:
            Xs, Ys = W / 2.0 + sc * (Xs - W / 2.0), H / 2.0 + sc * (Ys - H / 2.0)
        if k:
            # radial distortion: source radius scaled by (1 + k·r²), normalised
            # so the corners map to themselves and the frame stays full
            u, v = (Xs - W / 2.0) / half, (Ys - H / 2.0) / half
            f = (1.0 + k * (u * u + v * v)) / (1.0 + k)
            Xs, Ys = W / 2.0 + u * f * half, H / 2.0 + v * f * half
        Xl, Yl = Xs.tolist(), Ys.tolist()
        mesh = []
        for j in range(len(ys) - 1):
            for i in range(len(xs) - 1):
                mesh.append(((int(xs[i]), int(ys[j]), int(xs[i + 1]), int(ys[j + 1])),
                             (Xl[j][i], Yl[j][i], Xl[j + 1][i], Yl[j + 1][i],
                              Xl[j + 1][i + 1], Yl[j + 1][i + 1], Xl[j][i + 1], Yl[j][i + 1])))
        meshes.append(mesh)
    if len(meshes) == 1:
        return img.transform((cw, ch), Image.MESH, meshes[0], resample=Image.BICUBIC)
    return Image.merge("RGB", [band.transform((cw, ch), Image.MESH, m, resample=Image.BICUBIC)
                               for band, m in zip(img.split(), meshes)])


def _geometry(img, edits):
    """Orient, correct the lens, straighten and crop.

    The 90° steps and flips are lossless transposes; a plain crop is a crop.
    Anything that has to resample goes through one `_warp`.
    """
    rot = int(_f(edits, "rot")) % 360
    if rot == 90:
        img = img.transpose(Image.ROTATE_270)   # rot = clockwise degrees
    elif rot == 180:
        img = img.transpose(Image.ROTATE_180)
    elif rot == 270:
        img = img.transpose(Image.ROTATE_90)
    if edits.get("flipH"):
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    if edits.get("flipV"):
        img = img.transpose(Image.FLIP_TOP_BOTTOM)
    if any(_f(edits, k) for k in ("fine", "distort", "ca", "persV", "persH")):
        return _warp(img, edits)
    _rot, _frame_size, box = _frame(img.size[0], img.size[1], dict(edits, rot=0))
    if box != (0, 0) + img.size:
        return img.crop(box)
    return img


def _box1d(a, r, axis):
    """Running mean of width 2r+1 along `axis`, edges extended."""
    n = a.shape[axis]
    pad = [(r + 1, r) if i == axis else (0, 0) for i in range(a.ndim)]
    c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis)
    lo = np.take(c, np.arange(n), axis=axis)
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    return (hi - lo) / float(2 * r + 1)


def _smooth(a, r, passes=2):
    """Cheap gaussian-ish blur: repeated box blur, separable, all in numpy.

    The windows this runs on are a retouch region plus its rim, so integral-image
    box passes are both simpler and faster than pulling in a real convolution.
    """
    for _ in range(passes):
        a = _box1d(_box1d(a, r, 0), r, 1)
    return a


def _stroke_mask(size, pts, r):
    """Union of discs of radius `r` along the path `pts`, as an "L" image.

    One point is a spot, several are a brush stroke — the renderer never needs
    to know which. PIL draws (and clips) this in C, which is why a stroke costs
    the same as a dab.
    """
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    # consecutive duplicates make the joint geometry degenerate
    path = [tuple(p) for i, p in enumerate(pts) if i == 0 or tuple(p) != tuple(pts[i - 1])]
    if len(path) > 1:
        d.line(path, fill=255, width=max(1, 2 * r), joint="curve")
    for (x, y) in path:
        d.ellipse((x - r, y - r, x + r, y + r), fill=255)
    return m


def _paint_heal(img, pts, r, dx, dy, mode):
    """Heal (or clone) everything under a painted region, from one offset.

    The whole region is sourced by a single translation rather than dab by dab:
    independently chosen sources would each be plausible and together look like
    a patchwork, because the texture wouldn't line up across the stroke.

    Gradient-domain healing, the cheap stand-in for Poisson blending that phone
    editors use, does the rest. The annulus *around* the region is clean on both
    sides, so the source-minus-destination difference measured there is pure
    lighting mismatch; smoothing it inward extrapolates the correction across
    the region, which then inherits the destination's colour and shading. A
    single mean offset would stamp a flat patch onto a gradient and show its
    edge.

    Everything is clipped to the frame, so brushing off the edge of the picture
    simply paints the part that is on it. `img` is modified in place.
    """
    W, H = img.size
    if not pts or (dx == 0 and dy == 0):
        return
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    pad = int(r * 2.7) + 3          # room for the confidence ring and the feather
    # the window has to be inside the frame for the region *and* for the source
    # it is read from, so it is clipped against both
    bx0 = int(max(0, min(xs) - pad, -dx))
    by0 = int(max(0, min(ys) - pad, -dy))
    bx1 = int(min(W, max(xs) + pad + 1, W - dx))
    by1 = int(min(H, max(ys) + pad + 1, H - dy))
    if bx1 - bx0 < 4 or by1 - by0 < 4:
        return
    box = (bx0, by0, bx1, by1)
    size = (bx1 - bx0, by1 - by0)
    local = [(x - bx0, y - by0) for (x, y) in pts]   # masks only cover the window

    hard = _stroke_mask(size, local, r)
    alpha = np.asarray(hard.filter(ImageFilter.GaussianBlur(max(1.0, r * 0.35))),
                       np.float32)[..., None] / 255.0
    if alpha.max() <= 0.0:
        return

    dst = np.asarray(img.crop(box), np.float32)
    src = np.asarray(img.crop((bx0 + dx, by0 + dy, bx1 + dx, by1 + dy)), np.float32)
    if mode != "clone":
        inner = np.asarray(_stroke_mask(size, local, int(r * 1.5)), np.float32)
        outer = np.asarray(_stroke_mask(size, local, int(r * 2.5)), np.float32)
        conf = ((outer - inner) / 255.0)[..., None]
        if conf.sum() > 0:
            rb = max(2, int(r * 0.8))
            src = src + _smooth((dst - src) * conf, rb) / np.maximum(_smooth(conf, rb), 1e-6)
    merged = dst * (1.0 - alpha) + np.clip(src, 0.0, 255.0) * alpha
    img.paste(Image.fromarray(merged.astype(np.uint8)), (bx0, by0))


def _spot_geometry(s, W, H):
    """Normalise one stored retouch entry to (points in px, radius, dx, dy, mode).

    A brushed stroke stores its path and one source offset; a tapped spot stores
    a single point, and older ones store an absolute source point instead of an
    offset. They all render through the same painted-region path.
    """
    if not isinstance(s, dict):
        return None
    try:
        r = max(2, int(round(float(s["r"]) * min(W, H))))
        raw = s.get("pts") or [[s["x"], s["y"]]]
        pts = [(float(p[0]) * W, float(p[1]) * H) for p in raw if len(p) >= 2]
        if not pts:
            return None
        if "dx" in s or "dy" in s:
            dx = int(round(float(s.get("dx", 0)) * W))
            dy = int(round(float(s.get("dy", 0)) * H))
        else:   # legacy spot: an absolute source point, relative to the first dab
            dx = int(round(float(s["sx"]) * W)) - int(round(pts[0][0]))
            dy = int(round(float(s["sy"]) * H)) - int(round(pts[0][1]))
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    return pts, r, dx, dy, s.get("mode", "heal")


def _apply_spots(img, spots):
    """Apply the retouch list in order, each entry over the result of the last.

    Coordinates are normalised against this (already cropped) frame and the
    radius against its short edge, so the UI can paint on exactly the picture it
    draws.
    """
    W, H = img.size
    out = None
    for s in spots or ():
        geom = _spot_geometry(s, W, H)
        if not geom:
            continue
        if out is None:
            out = img.copy()          # only copy once we know we'll paint
        _paint_heal(out, *geom)
    return out if out is not None else img


def _find_paint_offset(img, pts, r):
    """Best single translation to source a painted region from, or None.

    Candidates are scored on how well their rim matches the rim around the
    region, with a penalty for busy source areas — pasting an edge or a texture
    boundary over a blemish trades one artefact for another. Candidates whose
    source would overlap the region itself are rejected outright: that is how a
    long stroke along a power line avoids healing it with more of the line.
    """
    W, H = img.size
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    pad = int(r * 2.7) + 3
    x0, y0 = int(max(0, min(xs) - pad)), int(max(0, min(ys) - pad))
    x1, y1 = int(min(W, max(xs) + pad + 1)), int(min(H, max(ys) + pad + 1))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    size = (x1 - x0, y1 - y0)
    local = [(x - x0, y - y0) for (x, y) in pts]

    step = max(1, r // 6)             # this is a similarity vote, not a render
    region = np.asarray(_stroke_mask(size, local, r))[::step, ::step] > 127
    inner = np.asarray(_stroke_mask(size, local, int(r * 1.5)))[::step, ::step] > 127
    outer = np.asarray(_stroke_mask(size, local, int(r * 2.5)))[::step, ::step] > 127
    rim = (outer & ~inner)
    if not rim.any() or not region.any():
        return None
    weight = rim.astype(np.float32)[..., None]
    total = float(weight.sum())
    dst = np.asarray(img.crop((x0, y0, x1, y1)), np.float32)[::step, ::step]

    # a long stroke needs a long escape route: every offset along its own axis
    # overlaps it and gets rejected, so give the search one that clears it
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    dists = [2.2 * r, 3.2 * r, 4.5 * r, 6.5 * r]
    if span > 4 * r:
        dists.append(0.6 * span + 2.2 * r)
    best, best_score = None, None
    for i in range(24):
        ang = i * math.pi / 12.0
        ca, sa = math.cos(ang), math.sin(ang)
        for dist in dists:
            dx, dy = int(round(ca * dist)), int(round(sa * dist))
            if x0 + dx < 0 or y0 + dy < 0 or x1 + dx > W or y1 + dy > H:
                continue
            if _shifted_overlap(region, dx // step, dy // step):
                continue
            src = np.asarray(img.crop((x0 + dx, y0 + dy, x1 + dx, y1 + dy)),
                             np.float32)[::step, ::step]
            score = float((((src - dst) ** 2) * weight).sum() / total)
            score += 0.4 * float(src[region].var())
            if best_score is None or score < best_score:
                best, best_score = (dx, dy), score
    if best is None:
        return None
    return best[0] / float(W), best[1] / float(H)


def _shifted_overlap(mask, dx, dy):
    """Does `mask` overlap itself translated by (dx, dy)?"""
    h, w = mask.shape
    if abs(dx) >= w or abs(dy) >= h:
        return False
    a = mask[max(0, dy):h + min(0, dy), max(0, dx):w + min(0, dx)]
    b = mask[max(0, -dy):h + min(0, -dy), max(0, -dx):w + min(0, -dx)]
    return bool((a & b).any())



def _apply_edits(img, edits, unit=1.0):
    """Apply the non-destructive edit stack to a PIL image; falsy = original.

    Order matters and mirrors what the UI draws on:

      orient (90° steps + flips, lossless)
      lens (distortion, chromatic aberration, keystone) — on the full frame,
        before anything crops it, so the corners are still there to correct
      straighten (auto-cropped to the largest inscribed rect)
      crop (normalized 0..1 of the rotated frame)
        — everything above is one resampling, see `_warp`
      retouch spots (normalized to the cropped frame — what the user clicked on)
      tone: exposure/highlights/shadows/whites/blacks, auto-levels, white
        balance, brightness, contrast, vibrance, saturation
      detail: clarity, noise reduction, sharpness
      look: black & white, vignette, grain
      border last, so its colour lands exactly as picked

    `unit` is how many pixels of `img` make one pixel of the reference
    rendering — the source at preview size, or at full size if it is smaller
    than that. Everything else here is proportional to the frame already;
    grain, sharpening and noise reduction work in pixels, and size themselves
    by `unit` so the 2400px preview, a thumbnail and a 6000px export of the
    same stack look the same at the same viewing size. (They used to be
    fixed-pixel filters, so the preview showed noticeably more grain,
    sharpening and smoothing than the export delivered.)
    """
    edits = applied_edits(edits)
    if not edits:
        return img
    img = _geometry(img, edits)

    if edits.get("spots"):
        img = _apply_spots(img, edits["spots"])

    # ---- tone & colour ----
    img = _tone_chain(img, edits)
    img = _saturate(img, _f(edits, "vibrance"), _f(edits, "saturation", 1.0))

    # ---- detail ----
    clarity = _f(edits, "clarity")
    if clarity:
        # local contrast: a blur ~1% of the frame wide, proportional already
        blur = _wide_blur(img, max(1.0, min(img.size) / 90.0))
        if clarity > 0:
            img = _unsharp(img, blur, clarity * 1.10, threshold=3)
        else:
            img = Image.blend(img, blur, min(0.85, -clarity * 0.85))
    nr = _f(edits, "denoise")
    if nr > 0:
        img = _denoise(img, nr, unit)
    shp = _f(edits, "sharpness", 1.0)
    if shp != 1.0:
        # ImageEnhance.Sharpness, with its fixed 3x3 smoothing kernel swapped
        # for a gaussian of the same width in reference pixels
        img = Image.blend(img.filter(ImageFilter.GaussianBlur(0.68 * unit)), img, shp)

    # ---- look ----
    if edits.get("bw"):
        img = ImageOps.grayscale(img).convert("RGB")
    vig = _f(edits, "vignette")
    if vig:
        img = _vignette(img, vig)
    grain = _f(edits, "grain")
    if grain > 0:
        img = _grain(img, grain, unit)

    b = edits.get("border")
    if isinstance(b, dict) and b.get("w"):
        # width is a fraction of the short edge, so previews and full-size
        # exports get the same visual proportion
        px = int(round(float(b["w"]) * min(img.size)))
        if px > 0:
            img = ImageOps.expand(img, border=px, fill=b.get("color", "#ffffff"))
    return img


def applied_edits(edits):
    """The stack minus `off`, or None if nothing is left.

    The UI parks switched-off adjustments under `off` so their values survive to
    be switched back on. They change no pixels, so everything that asks "is this
    edited" — cache keys, the export bake, save-copy — has to look past them, or
    a photo with every adjustment switched off renders and exports as edited.
    """
    if not edits:
        return None
    live = {k: v for k, v in edits.items() if k != "off"}
    return live or None


def _edits_tag(edits):
    edits = applied_edits(edits)
    if not edits:
        return ""
    return hashlib.md5(json.dumps(edits, sort_keys=True).encode("utf-8")).hexdigest()[:12]


def _url_tag(edits):
    """What the UI puts in a render URL to name its version: the edit stack
    and the pipeline version, so neither change can be served from the
    browser's cache."""
    return "{}.{}".format(RENDER_VERSION, _edits_tag(edits))


def get_edits(path):
    with db() as conn:
        row = conn.execute("SELECT edits FROM photos WHERE path=?", (path,)).fetchone()
    if row and row["edits"]:
        try:
            return applied_edits(json.loads(row["edits"]))
        except Exception:
            return None
    return None


def _cache_file(path, mtime, size_tag, edits_tag=""):
    key = "{}|{}|{}|{}|v{}".format(path, mtime, size_tag, edits_tag,
                                   RENDER_VERSION).encode("utf-8")
    h = hashlib.md5(key).hexdigest()
    return CACHE_DIR / "{}_{}.jpg".format(size_tag, h)


def _save_cache_jpeg(img, out, **kw):
    """Write a cache JPEG atomically.

    Renders run in a thread pool, so a second request can hit `out.exists()`
    while the first is still writing; without the rename it would serve (and
    the browser would cache) a truncated image.
    """
    if not kw.get("icc_profile"):
        kw.pop("icc_profile", None)
    tmp = out.with_name("{}.{}.part".format(out.name, threading.get_ident()))
    try:
        img.save(tmp, "JPEG", **kw)
        os.replace(str(tmp), str(out))
        _note_render()
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


# Startup used to be the only thing that ever pruned. A long editing session
# adds a render per slider release and, now, a preview-size decode per RAW, so
# the cache is also checked every so often while the app is up.
_renders_since_prune = 0
PRUNE_EVERY = 150


def _note_render():
    global _renders_since_prune
    _renders_since_prune += 1
    if _renders_since_prune >= PRUNE_EVERY:
        _renders_since_prune = 0
        threading.Thread(target=prune_cache, daemon=True).start()


def prune_cache(budget=CACHE_BUDGET):
    """Drop the oldest cache renders until the cache fits in `budget` bytes.

    Every slider commit bakes a new preview, so an editing session can add
    hundreds of MB; nothing else ever deletes them.
    """
    files, total = [], 0
    for f in CACHE_DIR.iterdir():
        try:
            st = f.stat()
        except OSError:
            continue
        if f.suffix == ".part":      # leftover from an interrupted render
            try:
                f.unlink()
            except OSError:
                pass
            continue
        files.append((st.st_mtime, st.st_size, f))
        total += st.st_size
    if total <= budget:
        return 0
    files.sort()
    freed = 0
    for _mt, size, f in files:
        if total - freed <= budget:
            break
        try:
            f.unlink()
            freed += size
        except OSError:
            pass
    return freed


# A full-res decode is hundreds of MB for a 45MP RAW and the grid fires dozens
# of thumbnail requests at once; without a cap the thread pool decodes 40 in
# parallel and the process balloons.
_render_sem = threading.Semaphore(max(2, min(8, os.cpu_count() or 4)))

_NO_EDITS = object()   # sentinel: "look up stored edits" vs an explicit (maybe {}) override

# Two requests for the same render (the loupe and a neighbour preload, the
# grid and the prefetcher) used to decode it twice in parallel. Work keyed
# here runs once; the second caller waits and then finds the result.
_flight_guard = threading.Lock()
_flights = {}


@contextmanager
def _single_flight(key):
    with _flight_guard:
        slot = _flights.setdefault(key, [threading.Lock(), 0])
        slot[1] += 1
    try:
        with slot[0]:
            yield
    finally:
        with _flight_guard:
            slot[1] -= 1
            if not slot[1]:
                _flights.pop(key, None)


# ---- render bases ----
#
# Every render starts from an un-edited, oriented base image, decoded no
# bigger than the render needs. Bases come in a few fixed sizes ("levels") so
# that the loupe, the live editor and the histogram share them: a crop that
# keeps half the frame needs a base twice the preview size to still fill the
# loupe at full detail, an uncropped thumbnail needs a small one.

BASE_LEVELS = (720, 1200, PREVIEW_SIZE, 3600, 4800, 7200, 9600)
FULL_LEVEL = 0          # "the source at full resolution"


class _Base(object):
    __slots__ = ("img", "icc", "src_size", "level")

    def __init__(self, img, icc, src_size, level):
        self.img, self.icc, self.src_size, self.level = img, icc, src_size, level


# Bases the loupe works on stay decoded in RAM, so live editor renders skip the
# decode and land fast enough to feel instant. Bounded by bytes, not count: a
# preview base is 11 MB, a full-resolution 45MP one 135 MB.
BASE_RAM_BUDGET = 640 * 1024 ** 2
_base_lock = threading.Lock()
_base_cache = OrderedDict()    # (path, mtime, full, level) -> _Base
_base_bytes = 0
_src_sizes = OrderedDict()     # (path, mtime, full) -> oriented full-res size


def _pick_level(need):
    """Smallest base level that covers `need` pixels of long edge (with a
    little slack — a render 10% short of the preview size is not worth
    decoding twice the pixels for)."""
    for lv in BASE_LEVELS:
        if lv >= 0.85 * need:
            return lv
    return FULL_LEVEL


def _cache_base(key, base):
    global _base_bytes
    with _base_lock:
        if key in _base_cache:
            return
        _base_cache[key] = base
        _base_bytes += base.img.size[0] * base.img.size[1] * 3
        while _base_bytes > BASE_RAM_BUDGET and len(_base_cache) > 1:
            _k, old = _base_cache.popitem(last=False)
            _base_bytes -= old.img.size[0] * old.img.size[1] * 3


def _base(path, mtime, full, level):
    """The un-edited source at `level` (long edge), as a _Base.

    `full` demosaics a RAW instead of lifting its embedded preview. That
    decode costs seconds, so its result is also written to the render cache —
    the price is paid once per photo, not once per visit or per session.
    """
    src_key = (path, mtime, full)
    known = _src_sizes.get(src_key)
    if known and level != FULL_LEVEL and level >= max(known):
        level = FULL_LEVEL                 # every bigger level is the same picture
    key = (path, mtime, full, level)
    with _base_lock:
        hit = _base_cache.get(key)
        if hit is not None:
            _base_cache.move_to_end(key)
            return hit
    if full and level != FULL_LEVEL and level < PREVIEW_SIZE:
        # small RAW bases come off the (disk-cached) preview-size decode
        big = _base(path, mtime, full, PREVIEW_SIZE)
        return _Base(_fit(big.img, level), big.icc, big.src_size, level)

    with _single_flight(("base",) + key):
        with _base_lock:
            hit = _base_cache.get(key)
        if hit is not None:
            return hit
        if full:
            src_size = known or _raw_size(path)
            if level != FULL_LEVEL and level >= max(src_size):
                level = FULL_LEVEL
            disk = _cache_file(path, mtime, "rawbase{}".format(level))
            img = None
            if disk.exists():
                try:
                    img = Image.open(disk)
                    img.load()
                except OSError:
                    img = None
            if img is None:
                # a full RAW decode is a few hundred MB; the semaphore keeps a
                # burst of them (arrow-keying through a folder) from stacking up
                half = level != FULL_LEVEL and max(src_size) // 2 >= level
                with _render_sem:
                    img = _load_raw_full(path, half)
                    if level != FULL_LEVEL:
                        img = _fit(img, level)
                _save_cache_jpeg(img, disk, quality=95, subsampling=0)
            base = _Base(img, None, src_size, level)
        else:
            with _render_sem:
                img, icc, src_size = _decode(path, level or None)
            if level != FULL_LEVEL and level >= max(src_size):
                level = FULL_LEVEL
            base = _Base(img, icc, src_size, level)
        with _base_lock:
            _src_sizes[src_key] = base.src_size
            while len(_src_sizes) > 4096:
                _src_sizes.popitem(last=False)
        if level == FULL_LEVEL or level >= PREVIEW_SIZE:
            _cache_base((path, mtime, full, level), base)
        return base


def _unit(base_img_size, src_size):
    """Pixels of this render per pixel of the reference rendering (see
    `_apply_edits`)."""
    return max(base_img_size) / float(min(max(src_size), PREVIEW_SIZE))


def render(path, long_edge, edits=_NO_EDITS, full=False):
    """Cached JPEG of `path`, `long_edge` pixels long, with `edits` baked in.

    Pass `edits` explicitly (including {} for the original) to render a live
    editor preview; leave it out to render the photo's stored edits. Either
    way the same stack lands in the same cache file, so the render the editor
    commits is the one the loupe, the grid and a later visit are served.
    `full` renders a RAW off a real demosaic — the same pixels the export
    starts from — instead of the embedded camera preview.

    The base is decoded no bigger than needed: a heavy crop gets a bigger
    base so the loupe still shows full detail, a thumbnail a small one. The
    pixel-sized filters are scaled to match (`unit`), so a render at any size
    is the full-size export, downsized.
    """
    try:
        st = os.stat(path)
    except OSError:
        raise HTTPException(status_code=404, detail="file not found")
    if edits is _NO_EDITS:
        edits = get_edits(path)
    edits = applied_edits(edits)
    full = bool(full) and _is_raw(path)      # full=1 on a JPEG has nothing to demosaic
    out = _cache_file(path, st.st_mtime, "{}{}".format(long_edge, "f" if full else ""),
                      _edits_tag(edits))
    if out.exists():
        return out
    with _single_flight(out.name):
        if out.exists():                   # another thread rendered it while we waited
            return out
        # a thumbnail is rendered a little bigger than it is shown, so the
        # final downsize has something to anti-alias
        need = long_edge * (1.5 if long_edge < 1000 else 1.0)
        base = _base(path, st.st_mtime, full, _pick_level(need))
        if edits:
            zoom = _frame_zoom(base.src_size[0], base.src_size[1], edits)
            if zoom > 1.0:
                level = _pick_level(need * zoom)
                if base.level != FULL_LEVEL and (level == FULL_LEVEL or level > base.level):
                    base = _base(path, st.st_mtime, full, level)
        unit = _unit(base.img.size, base.src_size)
        img = _apply_edits(base.img, edits, unit)
        unit *= min(1.0, long_edge / float(max(img.size)))
        img = _fit(img, long_edge)         # always a new image: the base is shared
        # previews keep full colour resolution (4:4:4): they are what colour
        # is judged on, and halving chroma shifts saturated edges visibly
        big = long_edge > THUMB_SIZE
        _save_cache_jpeg(img, out, quality=90 if big else 85, subsampling=0 if big else 2,
                         icc_profile=base.icc)
        _render_units[out.name] = unit
        while len(_render_units) > 2048:
            _render_units.popitem(last=False)
    return out


# out file name -> `unit` of that render, so the editor's live filters can
# size their blur the way the server did
_render_units = OrderedDict()


# ---- background thumbnails ----
#
# The grid tells the server which thumbnails it is about to show, in the order
# it shows them; one low-priority thread renders them ahead of the scroll.
# A new list replaces the old one, so re-sorting or opening another folder
# redirects the work instead of queueing behind it.

class _Prefetcher(object):
    def __init__(self):
        self.cv = threading.Condition()
        self.queue = deque()
        self.thread = None

    def submit(self, items):
        with self.cv:
            self.queue.clear()
            self.queue.extend(items)
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()
            self.cv.notify()

    def _run(self):
        while True:
            with self.cv:
                while not self.queue:
                    self.cv.wait()
                path, full = self.queue.popleft()
            try:
                render(path, THUMB_SIZE, full=full)
            except Exception:
                pass


_prefetcher = _Prefetcher()


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
        with os.scandir(folder) as it:
            for e in it:
                if Path(e.name).suffix.lower() in ALL_EXTS and e.is_file():
                    found.append(e.path)

    found.sort(key=lambda p: p.lower())

    with db() as conn:
        existing = {
            r["path"]: (r["mtime"], r["size"], r["taken"], r["meta_v"])
            for r in conn.execute(
                "SELECT path, mtime, size, taken, meta_v FROM photos WHERE folder=?",
                (folder,))
        }

    # A file already in the DB with the same mtime and size is left alone —
    # no EXIF read, no write. Only new or changed files are read.
    todo = []
    for full in found:
        try:
            st = os.stat(full)
        except OSError:
            continue
        prev = existing.get(full)
        if prev and prev[0] == st.st_mtime and prev[1] == st.st_size and prev[3] == META_VERSION:
            continue
        todo.append((full, st))
    if todo:
        taken = _capture_times([full for full, _st in todo])
        with _db_lock, db() as conn:
            conn.executemany(
                """
                INSERT INTO photos(path, folder, filename, mtime, size, flag, rating, taken, meta_v)
                VALUES(?, ?, ?, ?, ?, 0, 0, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    folder=excluded.folder,
                    filename=excluded.filename,
                    mtime=excluded.mtime,
                    size=excluded.size,
                    taken=excluded.taken,
                    meta_v=excluded.meta_v
                """,
                [(full, folder, os.path.basename(full), st.st_mtime, st.st_size, tk, META_VERSION)
                 for (full, st), tk in zip(todo, taken)],
            )

    # Drop rows for files that vanished from disk (deleted/moved outside the
    # app). Without this a restore lists them again with broken thumbnails, and
    # export/delete keep trying to touch paths that aren't there. Only rows this
    # scan didn't see are checked, and only a missing file is dropped — a
    # non-recursive rescan must not forget the subfolders it isn't looking at.
    seen = set(found)
    stale = [(p,) for p in existing if p not in seen and not os.path.isfile(p)]
    if stale:
        with _db_lock, db() as conn:
            conn.executemany("DELETE FROM photos WHERE path=?", stale)

    set_setting("last_folder", folder)
    set_setting("last_recursive", bool(recursive))
    return list_photos(found)


def _capture_times(paths):
    """Capture times for `paths`, in order.

    On a warm local disk reading EXIF is CPU work, and threads only fight
    over the GIL (3000 files: 0.3 s in one thread, 0.9 s in a pool). On a card
    reader or a network share it is mostly waiting, and a pool turns minutes
    into seconds. So the first few are timed, and the rest only go to a pool
    if they turn out to be slow.
    """
    head, rest = paths[:16], paths[16:]
    t0 = time.perf_counter()
    out = [capture_time(p) for p in head]
    if rest and (time.perf_counter() - t0) / max(1, len(head)) > 0.004:
        with ThreadPoolExecutor(max_workers=8) as pool:
            return out + list(pool.map(capture_time, rest))
    return out + [capture_time(p) for p in rest]


def current_folder(required=True):
    """The open scan folder as an absolute path, or None if there isn't one.

    Everything that acts in bulk (export, delete, split) scopes itself to this
    so marks from other folders are never touched.
    """
    folder = get_setting("last_folder")
    if folder and os.path.isdir(folder):
        return os.path.abspath(folder)
    if required:
        raise HTTPException(status_code=400, detail="no folder open")
    return None


def folder_rows(conn, folder, cols="*", where="", params=()):
    """Rows of the open folder that the grid is showing.

    Rows are filed under the folder they were scanned from, subfolders
    included. With "subfolders" unticked the grid shows only the top level —
    and export, delete and date split used to act on the hidden subfolder
    photos anyway. They only see what the grid sees now.
    """
    rows = conn.execute(
        "SELECT {} FROM photos WHERE folder=? {} ORDER BY path".format(cols, where),
        (folder,) + tuple(params)).fetchall()
    if get_setting("last_recursive", True):
        return rows
    return [r for r in rows if os.path.dirname(r["path"]) == folder]


def repath_moved(moved, edits_baked=()):
    """Point DB rows at files that moved on disk (export --move, date split).

    `moved` is [(old, new)]; paths in `edits_baked` get their stored edits
    dropped because the export already rendered them into the file.
    """
    if not moved:
        return
    baked = set(edits_baked)
    with _db_lock, db() as conn:
        for old, new in moved:
            conn.execute("DELETE FROM photos WHERE path=?", (new,))
            conn.execute(
                "UPDATE photos SET path=?, folder=?, filename=? WHERE path=?",
                (new, os.path.dirname(new), os.path.basename(new), old),
            )
            if new in baked:
                conn.execute("UPDATE photos SET edits=NULL WHERE path=?", (new,))


def photo_out(row):
    """A photo row for the UI, with the tag of its stored edits.

    The tag goes into thumbnail and preview URLs, so a URL names exactly one
    rendering and the browser can keep it forever — and a changed edit stack
    is a different URL, never a stale cached picture.
    """
    d = dict(row)
    edits = None
    if d.get("edits"):
        try:
            edits = json.loads(d["edits"])
        except (TypeError, ValueError):
            edits = None
    d["tag"] = _url_tag(edits)
    return d


def list_photos(paths):
    """Rows for `paths`, in that order.

    Chunked to stay under SQLite's variable limit — one query per 500 files
    instead of the one-SELECT-per-file this used to do (a 3000-shot folder
    meant 3000 round trips on every scan).
    """
    if not paths:
        return []
    found = {}
    with db() as conn:
        for i in range(0, len(paths), 500):
            chunk = paths[i:i + 500]
            rows = conn.execute(
                "SELECT {} FROM photos WHERE path IN ({})".format(
                    PHOTO_COLS, ",".join("?" * len(chunk))),
                chunk,
            )
            for r in rows:
                found[r["path"]] = photo_out(r)
    return [found[p] for p in paths if p in found]


# ----------------------------------------------------------------------------
# API models
# ----------------------------------------------------------------------------

class OpenReq(BaseModel):
    folder: str
    recursive: bool = True


class MarkReq(BaseModel):
    path: Optional[str] = None
    paths: Optional[List[str]] = None   # several at once (a RAW+JPEG pair, a compare verdict)
    flag: Optional[int] = None     # 1 keep, -1 reject, 0 none
    rating: Optional[int] = None   # 0..5


class DeleteReq(BaseModel):
    confirm: bool = False
    expected_count: int = -1   # client echoes the count it warned about; must match
    permanent: bool = False    # force permanent delete even if recycle bin available
    paths: Optional[List[str]] = None   # explicit subset; None = all rejected


class EditReq(BaseModel):
    path: str
    edits: Optional[dict] = None   # None/{} = revert to original


class RenderReq(BaseModel):
    path: str
    edits: Optional[dict] = None   # rendered as given; None/{} = the original
    full: bool = False             # off the RAW's demosaic instead of its preview
    size: int = PREVIEW_SIZE       # long edge; drafts ask for the pane's size


class PrefetchReq(BaseModel):
    items: List[list]              # [[path, full], ...] in the order the grid shows them


class SaveCopyReq(BaseModel):
    path: str
    source: Optional[str] = None   # render from this file instead (the RAW twin)


class PaintReq(BaseModel):
    path: str
    pts: List[List[float]]         # brush path, normalized to the displayed frame
    r: float
    edits: Optional[dict] = None
    full: bool = False             # search on the RAW decode the loupe is showing


class SplitReq(BaseModel):
    granularity: str = "day"        # day | month | year
    source: str = "taken"           # taken (EXIF, fallback mtime) | mtime
    action: str = "move"            # move | copy
    dest: Optional[str] = None      # None = subfolders inside the current folder


class ExportReq(BaseModel):
    dest: str
    action: str = "copy"        # "copy" | "move"
    selection: str = "keep"     # "keep" | "reject" | "rated"
    min_rating: int = 1         # used when selection == "rated"
    keep_structure: bool = False
    compress: bool = False      # re-encode JPEGs to shrink them
    quality: int = 85           # JPEG quality when compress is on
    # What to produce for a RAW file. Independent, so a shoot can go out as the
    # negative *and* a finished JPEG in one pass.
    # Both off = skip RAW files entirely (export the edited JPEG siblings only).
    raw_jpeg: bool = False      # render a JPEG from a full RAW decode, edits baked
    raw_copy: bool = True       # copy/move the RAW file itself
    raw_sidecar: bool = False   # write an .xmp beside the copied RAW


# ----------------------------------------------------------------------------
# App
# ----------------------------------------------------------------------------

app = FastAPI(title="Photo Culler")

_LOCAL_NAMES = ("127.0.0.1", "localhost", "[::1]")


@app.middleware("http")
async def local_only(request, call_next):
    """Refuse anything that isn't this machine's own UI talking to us.

    The server listens on localhost, but any page the user visits can still
    POST here from their browser — and these endpoints move and delete files.
    Our own UI sends no Origin (same-origin fetch) or sends this host's.

    The Host check closes DNS rebinding: a page on a hostile domain that
    re-points its own name at 127.0.0.1 is same-origin with itself, so the
    Origin test above passes — but its requests still say `Host: evil.example`.
    """
    host = request.headers.get("host", "")
    name = host[:host.find("]") + 1] if host.startswith("[") else host.split(":")[0]
    if host and name.lower() not in _LOCAL_NAMES:
        return JSONResponse({"detail": "unexpected Host header"}, status_code=403)
    origin = request.headers.get("origin")
    if request.method != "GET" and origin:
        if origin.split("//", 1)[-1] != host:
            return JSONResponse({"detail": "cross-site request blocked"}, status_code=403)
    return await call_next(request)


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
    # a folder that's gone (drive unplugged, renamed) reports as none rather
    # than showing a dead path as if it were open
    folder = current_folder(required=False)
    recursive = get_setting("last_recursive", True)
    photos = []
    if folder:
        with db() as conn:
            photos = [photo_out(r) for r in folder_rows(conn, folder, PHOTO_COLS)]
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


def _has_subdir(path):
    try:
        with os.scandir(path) as it:
            for e in it:
                if not e.name.startswith(".") and e.is_dir():
                    return True
    except OSError:
        pass
    return False


@app.get("/api/folder-tree")
def api_folder_tree(path: Optional[str] = Query(None)):
    """Return immediate subdirectories of `path` (or drive/home roots if omitted).

    Each entry: {name, path, has_children}. `has_children` stops at the first
    subfolder it finds instead of listing (and stat-ing) every child.
    """
    if not path:
        # Return filesystem roots: on Windows all lettered drives, on Unix just /
        if sys.platform == "win32":
            import string
            roots = []
            for letter in string.ascii_uppercase:
                p = letter + ":\\"
                if os.path.isdir(p):
                    roots.append({
                        "name": p,
                        "path": p,
                        "has_children": True,
                    })
            return {"entries": roots}
        else:
            return {"entries": [{"name": "/", "path": "/", "has_children": True}]}

    path = os.path.abspath(path)
    if not os.path.isdir(path):
        raise HTTPException(status_code=400, detail="not a directory")

    entries = []
    try:
        with os.scandir(path) as it:
            dirs = [e for e in it if not e.name.startswith(".") and e.is_dir()]
    except OSError:
        return {"entries": []}
    for e in sorted(dirs, key=lambda d: d.name.lower()):
        entries.append({"name": e.name, "path": e.path, "has_children": _has_subdir(e.path)})
    return {"entries": entries}


@app.post("/api/open")
def api_open(req: OpenReq):
    photos = scan_folder(req.folder, req.recursive)
    return {"folder": os.path.abspath(req.folder), "recursive": req.recursive,
            "photos": photos}


def _image(f, path, edits, t, m):
    """FileResponse for a render. A URL that names the exact version it shows
    (the edits tag and the file's mtime, as the UI builds them) is cached by
    the browser for good; anything else is revalidated every time."""
    fresh = False
    if t is not None and m is not None:
        try:
            fresh = t == _url_tag(edits) and float(m) == os.stat(path).st_mtime
        except (OSError, ValueError):
            fresh = False
    cc = "private, max-age=31536000, immutable" if fresh else "no-cache"
    return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": cc})


@app.get("/api/thumb")
def api_thumb(path: str = Query(...), full: int = Query(0),
              t: Optional[str] = Query(None), m: Optional[str] = Query(None)):
    # `full=1` decodes the negative instead of lifting its embedded camera JPEG,
    # so a RAW-mode grid shows the same rendering the loupe and the export do.
    # It shares the loupe's disk-cached preview-size decode, so the demosaic is
    # paid once per file, not once per view.
    edits = get_edits(path)
    return _image(render(path, THUMB_SIZE, edits, full=bool(full)), path, edits, t, m)


@app.get("/api/preview")
def api_preview(path: str = Query(...), edits: Optional[str] = Query(None),
                full: int = Query(0), t: Optional[str] = Query(None),
                m: Optional[str] = Query(None)):
    # `edits` (JSON) overrides stored edits; absent = use the photo's stored
    # edits. The editor itself posts to /api/render — a long retouch history
    # does not fit in a URL.
    if edits is not None:
        try:
            e = json.loads(edits)
        except Exception:
            e = {}
        f = render(path, PREVIEW_SIZE, e, full=bool(full))
        return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "no-store"})
    stored = get_edits(path)
    return _image(render(path, PREVIEW_SIZE, stored, full=bool(full)), path, stored, t, m)


@app.post("/api/render")
def api_render(req: RenderReq):
    """Render an edit stack the editor hasn't committed (or is about to).

    `size` lets a slider drag ask for a draft the size of the pane instead of
    the full preview; sizes are rounded so drafts share cache entries.
    """
    size = max(64, min(PREVIEW_SIZE, int(math.ceil(max(1, req.size) / 100.0) * 100)))
    f = render(req.path, size, req.edits or {}, full=req.full)
    headers = {"Cache-Control": "no-store"}
    unit = _render_units.get(f.name)
    if unit:
        headers["X-Render-Unit"] = "{:.4f}".format(unit)
    return FileResponse(f, media_type="image/jpeg", headers=headers)


@app.post("/api/prefetch")
def api_prefetch(req: PrefetchReq):
    items = [(it[0], bool(it[1]) if len(it) > 1 else False)
             for it in req.items[:50000] if it and isinstance(it[0], str)]
    _prefetcher.submit(items)
    return {"queued": len(items)}


def _ratio(v):
    """EXIF rationals arrive as IFDRational or as a (num, den) tuple."""
    if isinstance(v, tuple) and len(v) == 2:
        return v[0] / v[1] if v[1] else 0.0
    return float(v)


def _fmt_shutter(v):
    v = _ratio(v)
    if v <= 0:
        return None
    return "1/{:.0f}s".format(round(1 / v)) if v < 1 else "{:g}s".format(v)


@app.get("/api/meta")
def api_meta(path: str = Query(...), full: int = Query(0)):
    """Best-effort shooting info (EXIF) for the loupe info panel.

    Anything unreadable is simply null. A RAW's size comes from libraw's
    header (what an export renders), its EXIF from its TIFF container or its
    embedded preview. `full` is accepted for older clients; it no longer
    changes anything.
    """
    try:
        st = os.stat(path)
    except OSError:
        raise HTTPException(status_code=404, detail="file not found")
    out = {"size": st.st_size, "width": None, "height": None, "camera": None,
           "lens": None, "shutter": None, "aperture": None, "iso": None,
           "focal": None}
    try:
        if _is_raw(path):
            out["width"], out["height"] = _raw_size(path)
        else:
            with Image.open(path) as img:
                out["width"], out["height"] = _oriented_size(img.size, _orientation(img))
    except Exception:
        pass
    try:
        exif = _exif_of(path)
        if exif:
            make = str(exif.get(271, "")).strip().rstrip("\x00")
            model = str(exif.get(272, "")).strip().rstrip("\x00")
            if model:
                # many models already embed the make ("Canon EOS R5")
                dup = make and make.split(" ")[0].lower() in model.lower()
                out["camera"] = model if dup else (make + " " + model).strip()
            try:
                sub = exif.get_ifd(0x8769) or {}
            except Exception:
                sub = {}
            if sub.get(42036):
                out["lens"] = str(sub[42036]).strip().rstrip("\x00")
            if sub.get(33434):
                out["shutter"] = _fmt_shutter(sub[33434])
            if sub.get(33437):
                out["aperture"] = "f/{:g}".format(_ratio(sub[33437]))
            iso = sub.get(34855)
            if iso:
                out["iso"] = "ISO {}".format(int(iso[0]) if isinstance(iso, (list, tuple)) else int(iso))
            if sub.get(37386):
                out["focal"] = "{:g}mm".format(_ratio(sub[37386]))
    except Exception:
        pass
    return out


@app.post("/api/edit")
def api_edit(req: EditReq):
    val = json.dumps(req.edits) if req.edits else None
    with _db_lock, db() as conn:
        cur = conn.execute("UPDATE photos SET edits=? WHERE path=?", (val, req.path))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="unknown path")
    return {"ok": True, "path": req.path, "edits": req.edits, "tag": _url_tag(req.edits)}


# stages that don't move pixels around and only slow the source search down
_PAINT_SEARCH_SKIP = ("border", "grain", "denoise", "clarity", "sharpness", "vignette")


@app.post("/api/plan-paint")
def api_plan_paint(req: PaintReq):
    """Pick where a painted retouch region should source its pixels from.

    The client stores the answer in the stroke rather than letting the renderer
    search again: the search depends on resolution, and a preview that healed
    from one patch while the export healed from another would be a bug you only
    notice after the file is written.
    """
    try:
        st = os.stat(req.path)
    except OSError:
        raise HTTPException(status_code=404, detail="file not found")
    edits = {k: v for k, v in (req.edits or {}).items() if k not in _PAINT_SEARCH_SKIP}
    base = _base(req.path, st.st_mtime, bool(req.full) and _is_raw(req.path), PREVIEW_SIZE)
    img = _apply_edits(base.img, edits, _unit(base.img.size, base.src_size))
    W, H = img.size
    pts = [(float(p[0]) * W, float(p[1]) * H) for p in req.pts if len(p) >= 2]
    r = max(2, int(round(float(req.r) * min(W, H))))
    found = _find_paint_offset(img, pts, r)
    if not found:
        raise HTTPException(status_code=400, detail="no usable source area nearby")
    return {"dx": found[0], "dy": found[1]}


def _siblings(path):
    """Other files in `path`'s folder with the same base name (the JPEG beside
    a RAW, the RAW beside a JPEG)."""
    d, name = os.path.split(path)
    stem = os.path.splitext(name)[0].lower()
    try:
        names = os.listdir(d)
    except OSError:
        return []
    return [os.path.join(d, n) for n in names
            if n != name and os.path.splitext(n)[0].lower() == stem
            and os.path.splitext(n)[1].lower() in ALL_EXTS]


@app.post("/api/save-copy")
def api_save_copy(req: SaveCopyReq):
    """Bake a photo's edits into a new JPEG next to the original.

    The original is untouched; the copy is registered in the DB (same scan
    folder, no edits of its own) so it appears in the library immediately.
    """
    with db() as conn:
        row = conn.execute(
            f"SELECT {PHOTO_COLS} FROM photos WHERE path=?", (req.path,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="unknown path")
    if not os.path.isfile(req.path):
        raise HTTPException(status_code=404, detail="file not found")
    try:
        edits = applied_edits(json.loads(row["edits"])) if row["edits"] else None
    except (TypeError, ValueError):
        edits = None
    if not edits:
        raise HTTPException(status_code=400, detail="photo has no edits")

    # In RAW view the editor renders the negative, so a copy saved from that
    # view has to come off the negative too — baking the JPEG instead would hand
    # back a file that doesn't match what was on screen. Only a sibling of the
    # photo qualifies, so `source` can't point anywhere it likes.
    source = req.path
    if req.source and req.source != req.path:
        same_dir = os.path.dirname(req.source) == os.path.dirname(req.path)
        same_base = (os.path.splitext(os.path.basename(req.source))[0].lower() ==
                     os.path.splitext(os.path.basename(req.path))[0].lower())
        if not (same_dir and same_base and os.path.isfile(req.source)):
            raise HTTPException(status_code=400, detail="source is not a sibling of path")
        source = req.source
    raw_full = _is_raw(source)

    d = os.path.dirname(req.path)
    base = os.path.splitext(os.path.basename(req.path))[0]
    target = os.path.join(d, base + "_edited.jpg")
    n = 1
    while os.path.exists(target):
        target = os.path.join(d, "{}_edited_{}.jpg".format(base, n))
        n += 1
    _bake_to_jpeg(source, target, edits, 92, raw_full=raw_full, exif_from=(req.path,))

    target = os.path.abspath(target)
    st = os.stat(target)
    with _db_lock, db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO photos(path, folder, filename, mtime, size,
                                          flag, rating, taken, edits, meta_v)
            VALUES(?, ?, ?, ?, ?, 0, 0, ?, NULL, ?)
            """,
            (target, row["folder"], os.path.basename(target),
             st.st_mtime, st.st_size, row["taken"], META_VERSION),
        )
    with db() as conn:
        new = conn.execute(
            f"SELECT {PHOTO_COLS} FROM photos WHERE path=?", (target,)
        ).fetchone()
    return {"ok": True, "photo": photo_out(new)}


def _base_key(path):
    """(folder, lower-case base name): what a RAW+JPEG pair has in common."""
    return (os.path.dirname(path), os.path.splitext(os.path.basename(path))[0].lower())


@app.post("/api/split-by-date")
def api_split(req: SplitReq):
    folder = current_folder()
    dest_root = os.path.abspath(req.dest) if req.dest else folder
    fmt = {"day": "%Y-%m-%d", "month": "%Y-%m", "year": "%Y"}.get(req.granularity)
    if not fmt:
        raise HTTPException(status_code=400, detail="bad granularity")

    with db() as conn:
        rows = folder_rows(conn, folder, PHOTO_COLS)

    # A RAW+JPEG pair lands in one folder. The JPEG knows when it was taken and
    # the RAW often doesn't, so each member used to be dated on its own and a
    # shot near midnight could leave its negative behind in the next day.
    taken, mtimes = {}, {}
    for r in rows:
        key = _base_key(r["path"])
        mtimes[key] = min(mtimes.get(key, r["mtime"] or 0), r["mtime"] or 0)
        if req.source == "taken" and r["taken"]:
            taken[key] = min(taken.get(key, r["taken"]), r["taken"])
    group_ts = dict(mtimes)
    group_ts.update(taken)               # capture time where any member has one

    done = 0
    errors = []
    moved = []   # (old, new) for DB path fixups after a move
    for r in rows:
        src = r["path"]
        if not os.path.isfile(src):
            errors.append("missing: " + src)
            continue
        sub = datetime.fromtimestamp(group_ts.get(_base_key(src)) or 0).strftime(fmt)
        tdir = os.path.join(dest_root, sub)
        os.makedirs(tdir, exist_ok=True)
        target = os.path.join(tdir, os.path.basename(src))
        if os.path.abspath(target) == os.path.abspath(src):
            continue  # already in place
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

    repath_moved(moved)
    return {"moved": done, "action": req.action, "dest": dest_root, "errors": errors}


@app.post("/api/mark")
def api_mark(req: MarkReq):
    paths = list(req.paths or []) + ([req.path] if req.path else [])
    sets = []
    vals = []
    if req.flag is not None:
        sets.append("flag=?")
        vals.append(max(-1, min(1, int(req.flag))))
    if req.rating is not None:
        sets.append("rating=?")
        vals.append(max(0, min(5, int(req.rating))))
    if not sets or not paths:
        return {"ok": True}
    sql = "UPDATE photos SET {} WHERE path=?".format(", ".join(sets))
    with _db_lock, db() as conn:
        n = sum(conn.execute(sql, vals + [p]).rowcount for p in paths)
        if n == 0:
            raise HTTPException(status_code=404, detail="unknown path")
    if req.paths:
        return {"ok": True, "updated": n}
    with db() as conn:
        row = conn.execute(
            "SELECT path, flag, rating FROM photos WHERE path=?", (req.path,)
        ).fetchone()
    return dict(row)


# Renders are CPU-bound and mostly run in C, which lets threads overlap; half
# the cores keeps the UI responsive while an export runs.
EXPORT_WORKERS = max(1, min(4, (os.cpu_count() or 2) // 2))


@app.post("/api/export")
def api_export(req: ExportReq):
    """Stream export progress as Server-Sent Events.

    Each SSE event is JSON on a single `data:` line.
    - progress events: {type:"progress", done:int, total:int, name:str}
    - done event:      {type:"done", exported:int, dest:str, action:str,
                        files:[...], errors:[...]}

    Photos are exported by a small pool of workers; renders take seconds at
    full size, and one at a time left most of the machine idle.
    """
    dest = os.path.abspath(req.dest)
    os.makedirs(dest, exist_ok=True)

    folder = current_folder()
    with db() as conn:
        if req.selection == "keep":
            rows = folder_rows(conn, folder, "*", "AND flag=1")
        elif req.selection == "reject":
            rows = folder_rows(conn, folder, "*", "AND flag=-1")
        elif req.selection == "rated":
            rows = folder_rows(conn, folder, "*", "AND rating>=?", (int(req.min_rating),))
        else:
            raise HTTPException(status_code=400, detail="bad selection")
        # A RAW usually carries no edits of its own — they live on the JPEG the
        # UI showed while you were editing. Rendering "the JPEG from the RAW"
        # has to use that same stack, so look it up by base name.
        group_edits = {}
        for gr in folder_rows(conn, folder, "path, edits"):
            if gr["edits"]:
                group_edits.setdefault(_base_key(gr["path"]), gr["edits"])

    rows = list(rows)
    total = len(rows)
    quality = max(1, min(100, int(req.quality)))

    # a RAW that has a same-named sibling in this export needs a distinct name,
    # or the two renders would fight over <base>.jpg
    raw_siblings = set(_base_key(r["path"]) for r in rows
                       if os.path.splitext(r["path"])[1].lower() not in RAW_EXTS)

    # Workers pick names at the same time, so "is this name free" and "it's
    # mine" have to be one step.
    name_lock = threading.Lock()
    reserved = set()

    def free_target(tdir, name):
        """`name` inside tdir, suffixed until it doesn't overwrite anything."""
        t = os.path.join(tdir, name)
        stem, ext = os.path.splitext(t)
        k = 1
        with name_lock:
            while os.path.exists(t) or t.lower() in reserved:
                t = "{}_{}{}".format(stem, k, ext)
                k += 1
            reserved.add(t.lower())
        return t

    def export_one(r):
        """Export one row. Returns (exported, files, errors, moved, baked)."""
        src = r["path"]
        files, errors, moved, baked = [], [], [], []
        if not os.path.isfile(src):
            return 0, files, ["missing: " + src], moved, baked
        try:
            edits = applied_edits(json.loads(r["edits"])) if r["edits"] else None
        except (TypeError, ValueError):
            edits = None

        src_ext = os.path.splitext(src)[1].lower()
        is_raw = src_ext in RAW_EXTS
        if is_raw and not (req.raw_jpeg or req.raw_copy):
            # Neither RAW switch on = "leave the negatives out of it". The
            # JPEG sibling carries the same edits and is the only thing
            # going out; a move leaves the RAW where it is rather than
            # silently deleting it.
            return 0, files, errors, moved, baked
        is_jpeg = src_ext in {".jpg", ".jpeg"}
        do_compress = req.compress and is_jpeg
        bake = bool(edits) and not is_raw

        tdir = dest
        if req.keep_structure:
            sub = os.path.dirname(os.path.relpath(src, r["folder"] or dest))
            # a file that no longer lives under its scan root would relpath
            # to "..\.." and write outside `dest` — flatten those instead
            if not sub.startswith(".."):
                tdir = os.path.join(dest, sub)
        os.makedirs(tdir, exist_ok=True)

        stem = os.path.splitext(os.path.basename(src))[0]
        try:
            if is_raw:
                # A RAW can be exported as a finished JPEG rendered off the
                # negative, as the negative itself, or as both — the three
                # switches are independent and they are the whole story.
                # Edits alone never conjure a JPEG: the edits live on every
                # member of the group, so that would put a <stem>_raw.jpg
                # beside every edited JPEG whether or not it was asked for.
                grp = group_edits.get(_base_key(src))
                if grp:
                    try:
                        grp = applied_edits(json.loads(grp))
                    except (TypeError, ValueError):
                        grp = None
                if req.raw_jpeg:
                    suffix = "_raw" if _base_key(src) in raw_siblings else ""
                    target = free_target(tdir, stem + suffix + ".jpg")
                    _bake_to_jpeg(src, target, edits or grp,
                                  quality if req.compress else 92, raw_full=True,
                                  exif_from=_siblings(src))
                    files.append({"name": os.path.basename(target),
                                  "dest": os.path.abspath(target), "compressed": True})
                if req.raw_copy:
                    raw_target = free_target(tdir, os.path.basename(src))
                    if req.action == "move":
                        shutil.move(src, raw_target)
                        moved.append((src, os.path.abspath(raw_target)))
                    else:
                        shutil.copy2(src, raw_target)
                    if req.raw_sidecar:
                        _write_xmp_sidecar(raw_target, edits or grp, r["rating"], r["flag"])
                    files.append({"name": os.path.basename(raw_target),
                                  "dest": os.path.abspath(raw_target),
                                  "compressed": False})
                elif req.action == "move":
                    errors.append("kept RAW (a move would destroy it): " + src)
                return 1, files, errors, moved, baked

            name = os.path.basename(src)
            if bake and not is_jpeg:
                name = stem + ".jpg"
            target = free_target(tdir, name)
            if bake:
                _bake_to_jpeg(src, target, edits, quality if do_compress else 92)
                if req.action == "move":
                    os.remove(src)
                    moved.append((src, os.path.abspath(target)))
                    baked.append(os.path.abspath(target))
            elif do_compress:
                _compress_jpeg(src, target, quality)
                if req.action == "move":
                    os.remove(src)
                    moved.append((src, os.path.abspath(target)))
            elif req.action == "move":
                shutil.move(src, target)
                moved.append((src, os.path.abspath(target)))
            else:
                shutil.copy2(src, target)
            files.append({"name": os.path.basename(target),
                          "dest": os.path.abspath(target),
                          "compressed": do_compress or bake})
            return 1, files, errors, moved, baked
        except Exception as e:  # noqa
            return 0, files, errors + ["{}: {}".format(src, e)], moved, baked

    def event(obj):
        return "data: " + json.dumps(obj) + "\n\n"

    def generate():
        done = 0
        errors, files, moved, baked = [], [], [], []
        pool = ThreadPoolExecutor(max_workers=EXPORT_WORKERS)
        try:
            futures = {pool.submit(export_one, r): r for r in rows}
            for fut in as_completed(futures):
                try:
                    n, f, errs, mv, bk = fut.result()
                except Exception as e:  # noqa — one bad file must not end the stream
                    n, f, errs, mv, bk = 0, [], ["{}: {}".format(futures[fut]["path"], e)], [], []
                done += n
                files += f
                errors += errs
                moved += mv
                baked += bk
                yield event({"type": "progress", "done": done, "total": total,
                             "name": os.path.basename(futures[fut]["path"]),
                             "error": bool(errs)})
        finally:
            # a closed browser tab stops the queue; files already moved still
            # get their DB rows pointed at where they went
            pool.shutdown(wait=True, cancel_futures=True)
            repath_moved(moved, baked)
        yield event({"type": "done", "exported": done, "dest": dest,
                     "action": req.action, "files": files, "errors": errors})

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/delete-rejected")
def api_delete_rejected(req: DeleteReq):
    # scope to the open folder so stale rejects from past folders are untouched
    folder = current_folder()
    with db() as conn:
        rows = folder_rows(conn, folder, "path", "AND flag=-1")
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


def _free_port(host, port, tries=20):
    """`port` if it is free, else the next one that is.

    Starting a second copy — or having anything else on 8000 — used to be a
    stack trace and no app. There is a race between testing and binding, but
    for a tool that opens its own browser tab the printed URL is the answer.
    """
    for p in range(port, port + tries):
        s = socket.socket()
        # uvicorn binds with SO_REUSEADDR, so the probe must too: without it a
        # restart within a minute saw the old run's TIME_WAIT connections as
        # "port taken" and moved to the next port. (On Windows the flag means
        # something else — stealing a live port — so it stays off there.)
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    return port


def main():
    import uvicorn
    host = "127.0.0.1"
    port = 8000
    if "--port" in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        except (IndexError, ValueError):
            sys.exit("--port needs a number, e.g. --port 8080")
    port = _free_port(host, port)
    url = "http://{}:{}".format(host, port)
    threading.Thread(target=prune_cache, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print("Photo Culler running at " + url)
    uvicorn.run(app, host=host, port=port, log_level="warning")


init_db()

if __name__ == "__main__":
    main()

