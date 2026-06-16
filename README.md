# Photo Culler

A fast, keyboard-driven photo culling tool. Point it at a folder, fly through
your shots, flag keepers/rejects, rate them, compare similar frames side‑by‑side
with **synced zoom**, then export the keepers — all without touching the originals
until you say so.

Runs as a tiny local web app (Python backend + browser UI). Nothing leaves your
machine.

## Features

- **Any folder, optionally recursive** — scans subfolders too.
- **Formats:** JPEG / PNG / WebP / TIFF / GIF / BMP, **camera RAW** (CR2/CR3,
  NEF, ARW, RAF, RW2, DNG, ORF, …) and **HEIC/HEIF**. RAW uses the embedded
  preview for speed.
- **Fast grid** with lazy-loaded, cached thumbnails.
- **Loupe view** with scroll-to-zoom and drag-to-pan.
- **Compare mode** — 2–6 images side by side with **synchronized zoom & pan**
  (zoom one, they all zoom the same; great for picking the sharpest frame).
- **Non-destructive marking** — keep/reject flags + 0–5 star ratings stored in a
  local SQLite DB keyed by file path. Re-open the folder and your marks are back.
- **Filters** — view only keepers, rejects, unflagged, or rated photos.
- **Native folder picker** — a **Choose folder…** button opens your OS folder
  dialog (no path typing).
- **Export** — copy or move kept / rejected / rated photos into a folder
  (optionally preserving subfolder structure). Originals untouched unless you move.
- **Delete rejected** — clear out all rejected (X) shots in one go, behind two
  confirmation warnings. Sent to the **Recycle Bin** when `send2trash` is
  installed (recoverable); otherwise permanently deleted.

## Install

Requires Python 3.8+.

```bash
pip install -r requirements.txt
```

> RAW support needs `rawpy` and HEIC needs `pillow-heif`; both are in
> `requirements.txt`. If a wheel is unavailable for your platform the app still
> runs — it just skips that format.

## Run

```bash
python app.py
```

It starts at <http://127.0.0.1:8000> and opens your browser. Click
**📁 Choose folder…** in the top bar to pick a folder; the **↻** button rescans
the current one.

## Keyboard shortcuts

All shortcuts sit under the **left hand**, centred on the home row using the
**ESDF** nav cluster (index finger on `F`), so you can cull one-handed with the
other on the mouse.

| Key | Action |
| --- | --- |
| `E` `S` `D` `F` (or arrows) | Move selection (up / left / down / right) |
| `Home` / `End` | First / last photo |
| `G` / `Enter` | Open loupe (full) view |
| `Esc` | Back / close |
| `W` | Flag **Keep** (auto-advances) |
| `R` | Flag **Reject** (auto-advances) |
| `Q` | Clear flag |
| `1`–`5` | Star rating · `` ` `` = 0 stars |
| `Space` | Add/remove current photo from the compare set (auto-advances) |
| `C` | Open compare (the compare set, or current + next if none) |
| `X` | Clear compare set |
| `T` | Cycle filter |
| `B` | Toggle **mouse mode** |
| `V` / `?` | Show shortcuts |

**In loupe / compare:** scroll (or `E`/`D`) = zoom, drag = pan (synced across
compare panes), `S`/`F` = prev/next (loupe) or focus pane (compare), `Z` or
double-click = reset zoom. Marking keys work here too.

**Mouse mode (`B`):** the photo you hover is *semi-selected* (dashed outline) and
every hotkey acts on it instead of the keyboard cursor — hover, tap `E`/`Q`/a
rating, move to the next. No auto-advance in this mode (the mouse is your nav).

## How it stores things

- Marks & last-opened folder: `~/.photo_culler/culler.db` (SQLite).
- Thumbnail/preview cache: `~/.photo_culler/cache/` (safe to delete anytime;
  it regenerates).

## Notes

- RAW orientation relies on the embedded preview's EXIF; in rare cases a RAW may
  appear unrotated.
- The app binds to localhost only.
