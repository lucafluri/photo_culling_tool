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
- **Fast grid** with lazy-loaded, cached thumbnails and an adjustable
  **thumbnail-size slider** (remembered between sessions).
- **Sort** by filename, date taken, date modified, size, or rating — **newest
  first by default** (filename descending).
- **RAW + JPEG pairing** — same-named RAW and JPEG in a folder are combined into
  one item (tagged **`JPG+RAW`**). Marking, comparing, exporting and deleting act
  on the whole group, so the RAW and JPEG always stay in sync. Toggle with the
  **group RAW+JPG** checkbox.
- **Loupe view** with scroll-to-zoom and drag-to-pan.
- **Compare mode** — up to **3 images side by side** with **synchronized zoom &
  pan** (zoom one, they all zoom the same). Press `S`/`D`/`F` to keep the best one
  and reject the rest in a single tap.
- **Tournament voting** — select **more than 3** and compare runs a binary
  left‑vs‑right playoff (`←`/`S` vs `→`/`F`); the winner is kept, the rest
  rejected, and the comparison closes automatically.
- **Non-destructive marking** — keep/reject flags + 0–5 star ratings stored in a
  local SQLite DB keyed by file path. Re-open the folder and your marks are back.
- **Filters** — view only keepers, rejects, unflagged, or rated photos.
- **Native folder picker** — a **Choose folder…** button opens your OS folder
  dialog (no path typing).
- **Export** — copy or move kept / rejected / rated photos into a folder
  (defaults to `<photo folder>/cull_output`, optionally preserving subfolder
  structure). Originals untouched unless you move; on a **move**, marks follow the
  files to their new location and the folder is rescanned.
- **Delete rejected** — opens a **review grid** of every rejected (X) shot with
  thumbnails; click any to deselect (keep) it, then delete only what's left
  highlighted. Sent to the **Recycle Bin** when `send2trash` is installed
  (recoverable); otherwise permanently deleted.

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
| `S` `D` `F` | In compare (≤3): keep that image, reject the others, close |
| `X` | Clear compare set |
| `T` | Cycle filter |
| `B` | Toggle **mouse mode** |
| `V` / `?` | Show shortcuts |

**In loupe / compare:** scroll (or `E`/`D`) = zoom, drag = pan (synced across
compare panes), `S`/`F` = prev/next (loupe) or focus pane (compare), `Z` or
double-click = reset zoom. Marking keys work here too. In a ≤3 compare, `S`/`D`/`F`
pick the keeper; with **more than 3** selected, compare becomes a left‑vs‑right
**tournament** — vote `←`/`S` (left) or `→`/`F` (right) until one winner remains.

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
