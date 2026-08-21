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
import webbrowser
from collections import OrderedDict
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
from PIL import Image, ImageDraw, ImageOps, ImageEnhance, ImageFilter
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
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


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
                taken    REAL,
                edits    TEXT
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
        if "edits" not in cols:
            conn.execute("ALTER TABLE photos ADD COLUMN edits TEXT")


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


def _load_raw_full(path):
    """Full demosaic of a RAW file, for export.

    `_load_pil` deliberately reads the embedded preview — that is what makes a
    2000-shot RAW folder open in seconds — but the preview is a camera JPEG,
    smaller than the sensor and already cooked by the camera. When the point of
    the export is "give me the good version off the negative", decode properly.
    """
    if not HAVE_RAWPY or Path(path).suffix.lower() not in RAW_EXTS:
        return _load_pil(path)   # `full=1` asked for on a JPEG — nothing to demosaic
    with rawpy.imread(path) as raw:
        rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
    img = Image.fromarray(rgb)
    return img if img.mode == "RGB" else img.convert("RGB")


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


def _bake_to_jpeg(src, target, edits, quality, raw_full=False):
    """Render `src` with `edits` baked in and write a JPEG to `target`.

    Pixels are oriented and edited (rotate/flip/crop/tone applied); EXIF is
    carried over with the orientation tag cleared so viewers don't re-rotate an
    already-rotated image. Used by export so the exported file matches the
    edited preview.
    """
    img = _load_raw_full(src) if raw_full else _load_pil(src)
    img = _apply_edits(img, edits)
    exif = img.getexif()
    exif.pop(0x0112, None)          # Orientation — already baked into the pixels
    kw = {"quality": quality, "optimize": True, "exif": exif.tobytes()}
    icc = img.info.get("icc_profile")
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


def _by_strips(img, fn, rows=2048):
    """Run a numpy op band by band.

    A 45MP frame is 540 MB as float32 and these ops need several temporaries at
    once; up to `_render_sem` of them run in parallel. Bands keep the peak flat.
    `fn(sub, y_offset, full_height)` gets where its band sits in the whole frame.
    """
    W, H = img.size
    if H <= rows:
        return fn(img, 0, H)
    out = Image.new("RGB", (W, H))
    for y in range(0, H, rows):
        y1 = min(H, y + rows)
        out.paste(fn(img.crop((0, y, W, y1)), y, H), (0, y))
    return out


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


def _vibrance(img, amt):
    """Saturation weighted by how unsaturated a pixel already is.

    Skin and other already-saturated colours barely move, which is the whole
    point of having this next to the flat `saturation` control.
    """
    def band(sub, _y, _h):
        # saturation comes off the uint8 view (cheap min/max, no big temporary);
        # only the blend needs floats
        u8 = np.asarray(sub)
        mx = u8.max(2).astype(np.float32)
        sat = 1.0 - u8.min(2) / np.maximum(mx, 1e-6)
        arr = u8.astype(np.float32)
        lum = arr @ np.array([0.299, 0.587, 0.114], np.float32)
        out = lum[..., None] + (arr - lum[..., None]) * (1.0 + amt * (1.0 - sat))[..., None]
        return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    return _by_strips(img, band)


def _vignette(img, amt):
    """Radial gain. Positive darkens the corners, negative corrects lens falloff."""
    W, H = img.size
    cx, cy = (W - 1) / 2.0, (H - 1) / 2.0
    rx, ry = max(cx, 1e-6), max(cy, 1e-6)

    def band(sub, y0, _h):
        y, x = np.ogrid[y0:y0 + sub.size[1], 0:W]
        d2 = (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) / 2.0   # 0 centre, 1 corner
        arr = np.asarray(sub, np.float32) * (1.0 - amt * d2)[..., None]
        return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return _by_strips(img, band)


def _grain(img, amt):
    """Monochrome gaussian grain.

    Seeded from the band's position, so the same edits always render the same
    bytes — an unseeded rng would make every cache render a different picture.
    """
    def band(sub, y0, _h):
        w, h = sub.size
        noise = np.random.default_rng(9781 + y0).normal(0.0, 26.0 * amt, (h, w, 1))
        arr = np.asarray(sub, np.float32) + noise.astype(np.float32)
        return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    # ponytail: grain is sized in output pixels, so a thumbnail shows coarser
    # grain than the export. Scale by long edge if that ever matters.
    return _by_strips(img, band)


def _scale_about_centre(im, s):
    W, H = im.size
    return im.transform((W, H), Image.AFFINE,
                        (s, 0, W / 2.0 * (1 - s), 0, s, H / 2.0 * (1 - s)),
                        resample=Image.BILINEAR)


def _lens_distort(img, k, steps=24):
    """Radial distortion correction via a PIL mesh warp.

    Source radius is scaled by (1 + k·r²), normalised so r=1 (the corners) maps
    to itself — the frame stays full, no black wedges to crop away. The mesh is
    coarse and PIL interpolates inside each quad, which is why this costs
    milliseconds instead of a per-pixel remap in Python.
    """
    W, H = img.size
    cx, cy = W / 2.0, H / 2.0
    half = math.hypot(W, H) / 2.0
    denom = 1.0 + k

    pts = []
    for j in range(steps + 1):
        row = []
        for i in range(steps + 1):
            x, y = W * i / steps, H * j / steps
            u, v = (x - cx) / half, (y - cy) / half
            s = (1.0 + k * (u * u + v * v)) / denom
            row.append((u * s * half + cx, v * s * half + cy))
        pts.append(row)

    mesh = []
    for j in range(steps):
        for i in range(steps):
            box = (int(W * i / steps), int(H * j / steps),
                   int(W * (i + 1) / steps), int(H * (j + 1) / steps))
            nw, ne = pts[j][i], pts[j][i + 1]
            sw, se = pts[j + 1][i], pts[j + 1][i + 1]
            mesh.append((box, (nw[0], nw[1], sw[0], sw[1], se[0], se[1], ne[0], ne[1])))
    return img.transform((W, H), Image.MESH, mesh, resample=Image.BILINEAR)


def _lens_ca(img, amt):
    """Lateral chromatic aberration: scale red and blue against green."""
    e = 0.003 * amt
    r, g, b = img.split()
    return Image.merge("RGB", (_scale_about_centre(r, 1.0 + e), g,
                               _scale_about_centre(b, 1.0 - e)))


def _perspective(img, pv, ph):
    """Keystone correction.

    The output is the full frame and the *source* quad is a trapezoid inside the
    image, so every output pixel samples real pixels — the converging edge gets
    stretched back out instead of leaving empty corners behind.
    """
    W, H = img.size
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
        co = np.linalg.solve(np.array(A, np.float64), np.array(B, np.float64))
    except np.linalg.LinAlgError:
        return img
    return img.transform((W, H), Image.PERSPECTIVE, tuple(co), resample=Image.BICUBIC)


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


def _apply_edits(img, edits):
    """Apply the non-destructive edit stack to a PIL image; falsy = original.

    Order matters and mirrors what the UI draws on:

      orient (90° steps + flips, lossless)
      lens (distortion, chromatic aberration, keystone) — on the full frame,
        before anything crops it, so the corners are still there to correct
      straighten (auto-cropped to the largest inscribed rect)
      crop (normalized 0..1 of the rotated frame)
      retouch spots (normalized to the cropped frame — what the user clicked on)
      tone: exposure/highlights/shadows/whites/blacks, auto-levels, white
        balance, brightness, contrast, vibrance, saturation
      detail: clarity, noise reduction, sharpness
      look: black & white, vignette, grain
      border last, so its colour lands exactly as picked
    """
    edits = applied_edits(edits)
    if not edits:
        return img
    rot = int(edits.get("rot", 0)) % 360
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

    # ---- lens corrections ----
    distort = _f(edits, "distort")
    if distort:
        img = _lens_distort(img, distort)
    ca = _f(edits, "ca")
    if ca:
        img = _lens_ca(img, ca)
    pv, ph = _f(edits, "persV"), _f(edits, "persH")
    if pv or ph:
        img = _perspective(img, pv, ph)

    fine = _f(edits, "fine")
    if fine:
        w, h = img.size
        img = img.rotate(-fine, resample=Image.BICUBIC, expand=True)  # positive = CW
        wr, hr = _max_inscribed(w, h, math.radians(fine))
        W, H = img.size
        l = max(0, int((W - wr) / 2))
        t = max(0, int((H - hr) / 2))
        box = (l, t, min(W, int(l + wr)), min(H, int(t + hr)))
        if box[2] > box[0] and box[3] > box[1]:
            img = img.crop(box)
    crop = edits.get("crop")
    if crop and len(crop) == 4:
        w, h = img.size
        l, t, r, b = crop
        box = (int(l * w), int(t * h), int(r * w), int(b * h))
        if box[2] > box[0] and box[3] > box[1]:
            img = img.crop(box)

    if edits.get("spots"):
        img = _apply_spots(img, edits["spots"])

    # ---- tone ----
    exposure = _f(edits, "exposure")
    hi, sh = _f(edits, "highlights"), _f(edits, "shadows")
    wh, bl = _f(edits, "whites"), _f(edits, "blacks")
    if exposure or hi or sh or wh or bl:
        img = img.point(_tone_lut(exposure, hi, sh, wh, bl) * 3)
    if edits.get("auto"):
        # auto-levels: stretch the histogram, clipping 1% outliers per channel
        img = ImageOps.autocontrast(img, cutoff=1)
    # full white balance: independent +/- gain on red and blue. `temp` is the
    # older single-axis control (kept so photos edited before the R/B split
    # still render the same) — it nudges both channels oppositely, as before;
    # wbR/wbB move independently on top of that.
    temp = _f(edits, "temp")
    wb_r, wb_b = _f(edits, "wbR"), _f(edits, "wbB")
    if temp or wb_r or wb_b:
        r_gain = 1 + 0.3 * (temp + wb_r)
        b_gain = 1 + 0.3 * (-temp + wb_b)
        if r_gain != 1 or b_gain != 1:
            r, g, b = img.split()
            if r_gain != 1:
                r = r.point(lambda v: min(255, int(v * r_gain)))
            if b_gain != 1:
                b = b.point(lambda v: min(255, int(v * b_gain)))
            img = Image.merge("RGB", (r, g, b))
    for key, Enh in (("bright", ImageEnhance.Brightness),
                     ("contrast", ImageEnhance.Contrast)):
        v = edits.get(key)
        if v is not None and float(v) != 1.0:
            img = Enh(img).enhance(float(v))
    vib = _f(edits, "vibrance")
    if vib:
        img = _vibrance(img, vib)
    sat = edits.get("saturation")
    if sat is not None and float(sat) != 1.0:
        img = ImageEnhance.Color(img).enhance(float(sat))

    # ---- detail ----
    clarity = _f(edits, "clarity")
    if clarity:
        radius = max(2.0, min(img.size) / 90.0)
        if clarity > 0:
            img = img.filter(ImageFilter.UnsharpMask(
                radius=radius, percent=int(clarity * 110), threshold=3))
        else:
            img = Image.blend(img, img.filter(ImageFilter.GaussianBlur(radius)),
                              min(0.85, -clarity * 0.85))
    nr = _f(edits, "denoise")
    if nr > 0:
        # median keeps edges where a blur would smear them, and PIL runs it in C
        img = Image.blend(img, img.filter(ImageFilter.MedianFilter(3)), min(1.0, nr))
    shp = edits.get("sharpness")
    if shp is not None and float(shp) != 1.0:
        img = ImageEnhance.Sharpness(img).enhance(float(shp))

    # ---- look ----
    if edits.get("bw"):
        img = ImageOps.grayscale(img).convert("RGB")
    vig = _f(edits, "vignette")
    if vig:
        img = _vignette(img, vig)
    grain = _f(edits, "grain")
    if grain > 0:
        img = _grain(img, grain)

    b = edits.get("border")
    if b and b.get("w"):
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
    key = "{}|{}|{}|{}".format(path, mtime, size_tag, edits_tag).encode("utf-8")
    h = hashlib.md5(key).hexdigest()
    return CACHE_DIR / "{}_{}.jpg".format(size_tag, h)


def _save_cache_jpeg(img, out, **kw):
    """Write a cache JPEG atomically.

    Renders run in a thread pool, so a second request can hit `out.exists()`
    while the first is still writing; without the rename it would serve (and
    the browser would cache) a truncated image.
    """
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

# RAM cache of un-edited preview-size base images, so live editor renders skip
# the expensive full-res decode and land fast enough to feel instant.
_base_lock = threading.Lock()
_base_cache = OrderedDict()   # path -> (mtime, PIL image at PREVIEW_SIZE)


def _preview_base(path, mtime, full=False):
    """Un-edited image at preview size, RAM-cached (and disk-cached when `full`).

    `full` demosaics a RAW properly instead of lifting its embedded preview.
    That decode costs seconds, so the result is also written to the render cache
    — the price is paid once per photo, not once per visit or once per session.
    """
    key = (path, full)
    with _base_lock:
        v = _base_cache.get(key)
        if v and v[0] == mtime:
            _base_cache.move_to_end(key)
            return v[1]
    img = None
    disk = _cache_file(path, mtime, "rawbase", "") if full else None
    if disk is not None and disk.exists():
        try:
            img = Image.open(disk)
            img.load()
        except OSError:
            img = None
    if img is None:
        # a full RAW decode is a few hundred MB; the semaphore keeps a burst of
        # them (arrow-keying through a folder) from stacking up in memory
        with _render_sem:
            img = _load_raw_full(path) if full else _load_pil(path)
            img.thumbnail((PREVIEW_SIZE, PREVIEW_SIZE), Image.LANCZOS)
        if disk is not None:
            _save_cache_jpeg(img, disk, quality=92)
    with _base_lock:
        _base_cache[key] = (mtime, img)
        while len(_base_cache) > 4:
            _base_cache.popitem(last=False)
    return img


def get_rendered(path, long_edge, size_tag, edits=_NO_EDITS, full=False):
    """Generate (or fetch from cache) a JPEG resized to `long_edge`. Returns Path.

    Pass `edits` explicitly (incl. {} for original) to render a live editor
    preview; omit it to use the photo's stored edits. `full` renders a RAW off a
    real demosaic — the same pixels the export starts from — instead of the
    embedded camera preview, so the loupe shows what the export will produce.
    """
    try:
        st = os.stat(path)
    except OSError:
        raise HTTPException(status_code=404, detail="file not found")
    live = edits is not _NO_EDITS
    if not live:
        edits = get_edits(path)
    tag = _edits_tag(edits)
    if full:
        size_tag = size_tag + "full"     # a different picture, so a different key
    out = _cache_file(path, st.st_mtime, size_tag, tag)
    if out.exists():
        return out
    if full or (live and size_tag == "preview"):
        # ponytail: these renders edit a cached preview-size base and skip
        # `optimize` — a heavy crop previews below full detail until the stored
        # render replaces it. Live drafts get their own cache name so a quick
        # draft never gets served later as the committed render for the same
        # edits. `full` always takes this path: re-demosaicing 40MP on every
        # slider release would make RAW editing unusable, and the difference at
        # preview size is scale-dependent filters, not colour.
        draft = out if full else _cache_file(path, st.st_mtime, "draft", tag)
        if not draft.exists():
            img = _apply_edits(_preview_base(path, st.st_mtime, full), edits)
            img.thumbnail((long_edge, long_edge), Image.LANCZOS)
            _save_cache_jpeg(img, draft, quality=86)
        return draft
    with _render_sem:
        if out.exists():        # another thread rendered it while we waited
            return out
        img = _load_pil(path)
        img = _apply_edits(img, edits)
        img.thumbnail((long_edge, long_edge), Image.LANCZOS)
        _save_cache_jpeg(img, out, quality=86, optimize=True)
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
            for r in conn.execute(
                "SELECT path, mtime, taken FROM photos WHERE folder=?", (folder,))
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
                found[r["path"]] = dict(r)
    return [found[p] for p in paths if p in found]


# ----------------------------------------------------------------------------
# API models
# ----------------------------------------------------------------------------

class OpenReq(BaseModel):
    folder: str
    recursive: bool = True


class MarkReq(BaseModel):
    path: str
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


@app.middleware("http")
async def block_cross_site_writes(request, call_next):
    """Reject state-changing requests that came from another site.

    The server listens on localhost, but any page the user visits can still
    POST here from their browser — and these endpoints move and delete files.
    Our own UI sends no Origin (same-origin fetch) or sends this host's.
    """
    origin = request.headers.get("origin")
    if request.method != "GET" and origin:
        host = request.headers.get("host", "")
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


@app.get("/api/folder-tree")
def api_folder_tree(path: Optional[str] = Query(None)):
    """Return immediate subdirectories of `path` (or drive/home roots if omitted).

    Each entry: {name, path, has_children}.
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
        names = sorted(os.listdir(path), key=lambda n: n.lower())
    except PermissionError:
        return {"entries": []}

    for name in names:
        if name.startswith("."):
            continue
        full = os.path.join(path, name)
        if not os.path.isdir(full):
            continue
        try:
            has_children = any(
                os.path.isdir(os.path.join(full, c))
                for c in os.listdir(full)
                if not c.startswith(".")
            )
        except PermissionError:
            has_children = False
        entries.append({"name": name, "path": full, "has_children": has_children})

    return {"entries": entries}


@app.post("/api/open")
def api_open(req: OpenReq):
    photos = scan_folder(req.folder, req.recursive)
    return {"folder": os.path.abspath(req.folder), "recursive": req.recursive,
            "photos": photos}


@app.get("/api/thumb")
def api_thumb(path: str = Query(...), full: int = Query(0)):
    # `full=1` decodes the negative instead of lifting its embedded camera JPEG,
    # so a RAW-mode grid shows the same rendering the loupe and the export do.
    # It reuses the loupe's cached preview-size base, so the demosaic is paid
    # once per file, not once per view.
    f = get_rendered(path, THUMB_SIZE, "thumb", full=bool(full))
    return FileResponse(f, media_type="image/jpeg")


@app.get("/api/preview")
def api_preview(path: str = Query(...), edits: Optional[str] = Query(None),
                full: int = Query(0)):
    # `edits` (JSON) overrides stored edits for live editor previews; absent =
    # use the photo's stored edits. `full=1` decodes a RAW properly instead of
    # using its embedded preview, so the loupe matches the RAW export.
    if edits is not None:
        try:
            e = json.loads(edits)
        except Exception:
            e = {}
        f = get_rendered(path, PREVIEW_SIZE, "preview", edits=e, full=bool(full))
    else:
        f = get_rendered(path, PREVIEW_SIZE, "preview", full=bool(full))
    return FileResponse(f, media_type="image/jpeg")


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

    Anything unreadable is simply null — RAW support depends on how much of the
    TIFF container Pillow can parse.
    """
    try:
        st = os.stat(path)
    except OSError:
        raise HTTPException(status_code=404, detail="file not found")
    out = {"size": st.st_size, "width": None, "height": None, "camera": None,
           "lens": None, "shutter": None, "aperture": None, "iso": None,
           "focal": None}
    if full and HAVE_RAWPY and os.path.splitext(path)[1].lower() in RAW_EXTS:
        # the loupe is showing the demosaiced negative, which is not the size of
        # the camera JPEG beside it. libraw reads this out of the header, so it
        # costs nothing like a decode.
        try:
            with rawpy.imread(path) as raw:
                out["width"], out["height"] = raw.sizes.width, raw.sizes.height
                if raw.sizes.flip in (5, 6):     # 90° either way
                    out["width"], out["height"] = out["height"], out["width"]
        except Exception:
            pass
    try:
        with Image.open(path) as img:
            if not out["width"]:
                out["width"], out["height"] = img.size
            exif = img.getexif()
            make = str(exif.get(271, "")).strip()
            model = str(exif.get(272, "")).strip()
            if model:
                # many models already embed the make ("Canon EOS R5")
                dup = make and make.split(" ")[0].lower() in model.lower()
                out["camera"] = model if dup else (make + " " + model).strip()
            try:
                sub = exif.get_ifd(0x8769) or {}
            except Exception:
                sub = {}
            if sub.get(42036):
                out["lens"] = str(sub[42036]).strip()
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
    return {"ok": True, "path": req.path, "edits": req.edits}


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
    edits = dict(req.edits or {})
    edits.pop("border", None)      # the client hides the border while retouching
    img = _apply_edits(_preview_base(req.path, st.st_mtime, req.full), edits)
    W, H = img.size
    pts = [(float(p[0]) * W, float(p[1]) * H) for p in req.pts if len(p) >= 2]
    r = max(2, int(round(float(req.r) * min(W, H))))
    found = _find_paint_offset(img, pts, r)
    if not found:
        raise HTTPException(status_code=400, detail="no usable source area nearby")
    return {"dx": found[0], "dy": found[1]}


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
    raw_full = os.path.splitext(source)[1].lower() in RAW_EXTS

    d = os.path.dirname(req.path)
    base = os.path.splitext(os.path.basename(req.path))[0]
    target = os.path.join(d, base + "_edited.jpg")
    n = 1
    while os.path.exists(target):
        target = os.path.join(d, "{}_edited_{}.jpg".format(base, n))
        n += 1
    _bake_to_jpeg(source, target, edits, 92, raw_full=raw_full)

    target = os.path.abspath(target)
    st = os.stat(target)
    with _db_lock, db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO photos(path, folder, filename, mtime, size,
                                          flag, rating, taken, edits)
            VALUES(?, ?, ?, ?, ?, 0, 0, ?, NULL)
            """,
            (target, row["folder"], os.path.basename(target),
             st.st_mtime, st.st_size, row["taken"]),
        )
    with db() as conn:
        new = conn.execute(
            f"SELECT {PHOTO_COLS} FROM photos WHERE path=?", (target,)
        ).fetchone()
    return {"ok": True, "photo": dict(new)}


@app.post("/api/split-by-date")
def api_split(req: SplitReq):
    folder = current_folder()
    dest_root = os.path.abspath(req.dest) if req.dest else folder
    fmt = {"day": "%Y-%m-%d", "month": "%Y-%m", "year": "%Y"}.get(req.granularity)
    if not fmt:
        raise HTTPException(status_code=400, detail="bad granularity")

    with db() as conn:
        rows = conn.execute(
            f"SELECT {PHOTO_COLS} FROM photos WHERE folder=?", (folder,)
        ).fetchall()

    done = 0
    errors = []
    moved = []   # (old, new) for DB path fixups after a move
    for r in rows:
        src = r["path"]
        if not os.path.isfile(src):
            errors.append("missing: " + src)
            continue
        ts = r["taken"] if (req.source == "taken" and r["taken"]) else r["mtime"]
        sub = datetime.fromtimestamp(ts or 0).strftime(fmt)
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
    """Stream export progress as Server-Sent Events.

    Each SSE event is JSON on a single `data:` line.
    - progress events: {type:"progress", done:int, total:int, name:str}
    - done event:      {type:"done", exported:int, dest:str, action:str,
                        files:[...], errors:[...]}
    """
    dest = os.path.abspath(req.dest)
    os.makedirs(dest, exist_ok=True)

    folder = current_folder()
    with db() as conn:
        if req.selection == "keep":
            rows = conn.execute(
                "SELECT * FROM photos WHERE flag=1 AND folder=?", (folder,)).fetchall()
        elif req.selection == "reject":
            rows = conn.execute(
                "SELECT * FROM photos WHERE flag=-1 AND folder=?", (folder,)).fetchall()
        elif req.selection == "rated":
            rows = conn.execute(
                "SELECT * FROM photos WHERE rating>=? AND folder=?",
                (int(req.min_rating), folder)).fetchall()
        else:
            raise HTTPException(status_code=400, detail="bad selection")

    rows = list(rows)
    total = len(rows)
    quality = max(1, min(100, int(req.quality)))

    # A RAW usually carries no edits of its own — they live on the JPEG the UI
    # showed while you were editing. Rendering "the JPEG from the RAW" has to
    # use that same stack, so look it up by base name within the folder.
    def _base_key(path):
        return (os.path.dirname(path), os.path.splitext(os.path.basename(path))[0].lower())

    group_edits = {}
    with db() as conn:
        for gr in conn.execute("SELECT path, edits FROM photos WHERE folder=?", (folder,)):
            if gr["edits"]:
                group_edits.setdefault(_base_key(gr["path"]), gr["edits"])
    # a RAW that has a same-named sibling in this export needs a distinct name,
    # or the two renders would fight over <base>.jpg
    raw_siblings = set(_base_key(r["path"]) for r in rows
                       if os.path.splitext(r["path"])[1].lower() not in RAW_EXTS)

    def generate():
        done = 0
        errors = []
        files = []
        moved = []
        baked = set()

        for r in rows:
            src = r["path"]
            name_display = os.path.basename(src)

            if not os.path.isfile(src):
                errors.append("missing: " + src)
                yield "data: " + json.dumps({
                    "type": "progress", "done": done, "total": total,
                    "name": name_display, "error": True
                }) + "\n\n"
                continue

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
                yield "data: " + json.dumps({
                    "type": "progress", "done": done, "total": total,
                    "name": name_display, "error": False
                }) + "\n\n"
                continue
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

            def free_target(name):
                """`name` inside tdir, suffixed until it doesn't overwrite anything."""
                t = os.path.join(tdir, name)
                stem, ext = os.path.splitext(t)
                k = 1
                while os.path.exists(t):
                    t = "{}_{}{}".format(stem, k, ext)
                    k += 1
                return t

            stem = os.path.splitext(os.path.basename(src))[0]
            target = None
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
                    want_jpeg = req.raw_jpeg
                    want_copy = req.raw_copy
                    if want_jpeg:
                        suffix = "_raw" if _base_key(src) in raw_siblings else ""
                        target = free_target(stem + suffix + ".jpg")
                        _bake_to_jpeg(src, target, edits or grp,
                                      quality if req.compress else 92, raw_full=True)
                        files.append({"name": os.path.basename(target),
                                      "dest": os.path.abspath(target), "compressed": True})
                    if want_copy:
                        raw_target = free_target(os.path.basename(src))
                        if req.action == "move":
                            shutil.move(src, raw_target)
                            moved.append((src, os.path.abspath(raw_target)))
                        else:
                            shutil.copy2(src, raw_target)
                        if req.raw_sidecar:
                            _write_xmp_sidecar(raw_target, edits or grp,
                                               r["rating"], r["flag"])
                        files.append({"name": os.path.basename(raw_target),
                                      "dest": os.path.abspath(raw_target),
                                      "compressed": False})
                        target = target or raw_target
                    elif req.action == "move":
                        errors.append("kept RAW (a move would destroy it): " + src)
                    done += 1
                else:
                    name = os.path.basename(src)
                    if bake and not is_jpeg:
                        name = stem + ".jpg"
                    target = free_target(name)
                    if bake:
                        _bake_to_jpeg(src, target, edits, quality if do_compress else 92)
                        if req.action == "move":
                            os.remove(src)
                            moved.append((src, os.path.abspath(target)))
                            baked.add(os.path.abspath(target))
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
                    done += 1
            except Exception as e:  # noqa
                errors.append("{}: {}".format(src, e))

            yield "data: " + json.dumps({
                "type": "progress", "done": done, "total": total,
                "name": name_display, "error": False
            }) + "\n\n"

        repath_moved(moved, baked)
        yield "data: " + json.dumps({
            "type": "done", "exported": done, "dest": dest,
            "action": req.action, "files": files, "errors": errors
        }) + "\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/delete-rejected")
def api_delete_rejected(req: DeleteReq):
    # scope to the open folder so stale rejects from past folders are untouched
    folder = current_folder()
    with db() as conn:
        rows = conn.execute(
            "SELECT path FROM photos WHERE flag=-1 AND folder=?", (folder,)).fetchall()
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
