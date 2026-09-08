# Photo Culler

A local web app for culling photo shoots. Point it at a folder and every
keep/reject/rate decision sits on a key under the left hand.

Python (FastAPI) backend, plain JavaScript frontend. It binds to localhost and
uploads nothing. Marks live in SQLite keyed by file path, and nothing on disk
moves until you export.

## Screenshots

<!--
Drop image files in docs/screenshots/ and they'll show up below.
Suggested shots: the grid view, loupe/full view, and compare mode.
-->

| Grid | Loupe | Compare |
| --- | --- | --- |
| ![Grid view](docs/screenshots/grid.png) | ![Loupe view](docs/screenshots/loupe.png) | ![Compare mode](docs/screenshots/compare.png) |

## Install

Python 3.8 or newer.

```bash
pip install -r requirements.txt
python app.py
```

Opens <http://127.0.0.1:8000> in a browser tab. `--no-browser` skips the tab,
`--port 8080` moves it. If the port is taken the next free one is used and the
real URL printed.

Pick a folder with **Choose folder...** (OS dialog) or **📂** (in-app tree).
**↻** rescans the current one.

RAW needs `rawpy`, HEIC needs `pillow-heif`. Both are in `requirements.txt`. If
no wheel exists for your platform the app still runs and skips those formats.

## What it reads

JPEG, PNG, WebP, TIFF, GIF, BMP, HEIC/HEIF, and camera RAW (CR2/CR3, NEF, ARW,
RAF, RW2, DNG, ORF and others). Subfolders optional.

RAW browsing uses the embedded preview, so a 2000-shot folder opens in seconds.
Capture time is read from EXIF, including out of the TIFF-container RAWs (NEF,
ARW, CR2, DNG and most others). CR3 and the other ISO-BMFF formats fall back to
file mtime.

A RAW and a JPEG sharing a base name collapse into one grid item tagged
`JPG+RAW`. Marking, comparing, exporting and deleting act on both. Turn it off
with **group RAW+JPG**.

## Culling

Flags are keep/reject, ratings are 0 to 5 stars, both stored in SQLite so
reopening a folder brings them back. `U` undoes the last mark, including a
whole compare verdict or bulk mark.

Sort by filename, date taken, date modified, size or rating. Filter by flag,
rating or file type, or type a few characters to filter by filename (`/`
focuses the box). Sort, filter, search, thumbnail size and fit/fill mode
persist between sessions. The header counts what is still unflagged.

Selecting: `Space` toggles one photo, shift-click takes a range from the
cursor, ctrl-click picks individual frames, `A` takes everything on screen. The
selection drives compare, bulk marking (`Shift` plus a flag or rating key),
paste, presets and export.

Compare shows up to 3 images side by side with synced zoom and pan. `S`, `D` or
`F` keeps that frame and rejects the rest. Select more than 3 and it becomes a
left-versus-right knock-out (`←`/`S` against `→`/`F`) that runs until one frame
is left.

**Mouse mode** (`B`, on by default) points every hotkey at the photo under the
cursor instead of at the keyboard selection. There is no auto-advance in this
mode.

## Editing

Loupe view: scroll to zoom, drag to pan, `Z` or double-click for fit vs 100%
centred on the pointer. A filmstrip along the bottom jumps to any frame, `L`
hides it, and the left and right edges of the picture are prev/next buttons.
`Tab` hides the edit sidebar; each section also collapses on its own.

**Crop & Rotate**: 90° steps, flips, fine straighten with auto-crop to the
largest inscribed rectangle, and a crop box (`C`) that can be locked to free,
original, 1:1, 3:2, 2:3, 4:3, 3:4, 4:5, 5:4, 16:9 or 9:16.

**Lens**: barrel/pincushion distortion, lateral chromatic aberration, and
vertical/horizontal keystone. All run on the full frame before the crop and
keep the frame filled, so there are no black corners to trim off.

**Light**: exposure in stops, contrast, highlights, shadows, whites, blacks,
brightness, auto-levels.

**Color**: independent red and blue white-balance gains, vibrance (weighted by
how unsaturated a pixel already is, so skin barely moves), saturation, black &
white.

**Detail**: clarity (negative for a soft look), sharpness, noise reduction.

**Retouch** (`P`): a healing brush, with a ring under the cursor at the size
the next stroke will use. **Brush** paints over what you drag across. **Spot**
fixes one blemish per click and lets you drag out the source yourself.
Otherwise the source is picked for you from the calmest nearby area that
matches, skipping anything that overlaps the stroke itself. **Heal**
blends in the gradient domain so the patch inherits the surrounding colour and
shading; **Clone** copies pixels as they are. Click a painted region to remove
it. Strokes land where you paint at any zoom, brushing off the edge of the
frame is fine, and the middle button pans while you work.

**Effects**: vignette (positive darkens the corners, negative corrects lens
falloff), film grain, and a solid border with width and colour.

Every slider has tick marks, a type-in numeric field, and resets on
double-click. Sliders with a CSS equivalent preview live as you drag; the rest
render a server draft on each pause.

The **Histogram** panel overlays the original's tone curve in white and lists
every active adjustment. Click a line to park that one adjustment, click again
to bring it back with its value intact.

Edits are stored per photo as an undo/redo history (`Ctrl+Z` / `Ctrl+Y`).
`Ctrl+C` / `Ctrl+V` copies a whole stack onto another photo, and presets save
one by name. `O` toggles original vs edited, `I` opens EXIF, `G` toggles the
alignment grid. Edited photos show a live preview and a ✎ badge in the grid.

A RAW+JPEG pair edits as one photo, with the stack mirrored onto both files.

### JPEG or RAW

For a photo with a negative behind it, the Info section offers a **JPEG / RAW**
switch. The camera JPEG carries the camera's film simulation; an export
rendered from the negative goes through libraw. The two do not look alike.

In RAW view the whole editor works off the negative, **Save copy** included.
The first decode takes a few seconds and shows a spinner, then it is cached to
disk. Compare and the knock-out always use the fast embedded previews. The
switch is remembered between sessions, and ticking "JPEG rendered from the RAW"
in the export dialog turns it on.

### Non-destructive

The file on disk is never rewritten, so **Reset** always gets you back. Export
bakes the edits into the output. **Save copy** writes `<name>_edited.jpg` next
to the original and adds it to the library.

Rotating, flipping, straightening or a lens correction drops the crop and
clears the retouch spots, since both are expressed in the frame those moves
change. Re-cropping remaps the spots instead.

## Getting photos back out

**Export** copies or moves kept, rejected, rated, or exactly what is selected
in the grid, into a folder (default `<photo folder>/cull_output`), optionally
keeping the subfolder structure. Edited photos go out as JPEG with everything
baked in; the rest are copied byte for byte, or re-encoded at a chosen quality.
EXIF is carried over from the original with only the orientation tag dropped.

RAW files get three independent switches:

- **JPEG rendered from the RAW**: a full demosaic of the negative with the
  edits baked in. Named `<name>_raw.jpg` if a JPEG sibling is in the same
  export.
- **The RAW file itself**: copied or moved alongside.
- **An .xmp sidecar**: the rating and keep/reject label in standard XMP where
  other software reads them, and the edit stack in a `culler:` namespace.

Untouched, they copy the RAW and also render a baked JPEG if it carries edits.
A move that would destroy an un-copied edited RAW is refused and reported.
Moving updates marks to the new paths and rescans.

**Date split** moves or copies photos into subfolders named by date taken or
date modified, inside the current folder or somewhere you pick.

**Delete rejected** opens a review grid of every rejected shot. Click a photo
to spare it, then delete what is still highlighted. Deletion goes to the
Recycle Bin through `send2trash`, or is permanent if that package is missing.

## Keyboard shortcuts

Built around the **ESDF** cluster with the index finger on `F`, so the cull
runs under the left hand and the right one stays on the mouse.

| Key | Action |
| --- | --- |
| `E` `S` `D` `F` (or arrows) | Move the cursor |
| `Home` / `End` | First / last photo |
| `PgUp` / `PgDn` | A screenful at a time |
| `/` | Filter by filename (`Esc` clears it) |
| `G` / `Enter` | Open loupe view |
| `Esc` | Back / close |
| `W` | Flag **Keep** (auto-advances) |
| `R` | Flag **Reject** (auto-advances) |
| `Q` | Clear flag |
| `1`-`5` | Star rating, `0` or `` ` `` = no stars |
| `Shift` + any mark key | Mark the whole selection |
| `U` | Undo last mark |
| `Space` | Add/remove the current photo from the selection |
| `A` | Select everything on screen, or clear it |
| `X` | Clear the selection |
| `C` | Open compare (the selection, or current + next) |
| `S` `D` `F` | In compare, 3 or fewer: keep that one, reject the rest, close |
| `Z` | Loupe/compare: fit vs 100% |
| `L` | Loupe: show/hide the filmstrip |
| `P` | Retouch (loupe) |
| `I` | EXIF panel (loupe) |
| `Ctrl`+`Z` / `Ctrl`+`Y` | Undo / redo edits (loupe) |
| `Ctrl`+`C` / `Ctrl`+`V` | Copy / paste edits between photos |
| `T` | Cycle filter |
| `B` | Toggle mouse mode |
| `V` / `?` | Show shortcuts |

In loupe and compare, scrolling (or `E`/`D`) zooms, dragging pans and stays
synced across compare panes, and `S`/`F` moves between photos in loupe or
focuses a pane in compare. Marking keys and the edit bar keep working on
whichever photo is current. In retouch mode the left button paints, so pan with
the middle button.

The folder tree takes the arrow keys as well: up and down move, right descends,
left goes back up, `Enter` opens, `Esc` closes.

## Where things are stored

- Marks, edits and the last-opened folder: `~/.photo_culler/culler.db`, or
  `$PHOTO_CULLER_HOME` if that variable is set.
- Rendered thumbnails and previews: `~/.photo_culler/cache/`. Safe to delete at
  any time; it regenerates. Pruned back to 2 GB, oldest first, at startup and
  periodically while the app is running.
- Rescanning a folder drops rows for files that no longer exist, so marks for
  deleted photos do not accumulate.

## Development

```bash
python test_edits.py   # the edit pipeline (rotate/crop/tone/border maths)
python test_api.py     # the HTTP API end to end, on a throwaway library
```

`test_api.py` boots the real app on port 8123 with `PHOTO_CULLER_HOME` pointed
at a temp directory, so it cannot touch your own database or cache. Set that
variable yourself if you want a scratch library:

```bash
PHOTO_CULLER_HOME=/tmp/culler-scratch python app.py
```

## Known limitations

- RAW orientation comes from the embedded preview's EXIF, so a RAW can
  occasionally show up unrotated.
- Switching the loupe to RAW switches the grid with it, so the first pass over
  a RAW folder in that mode pays one demosaic per file. Cached on disk, so only
  once.
- A RAW that libraw cannot read (a truncated file, a body newer than the
  installed libraw) reports an error and the loupe falls back to the camera
  JPEG. Exporting one is refused and listed in the export errors.
- Previews render edits at 2400px, exports at full size. Grain is sized against
  the frame so it matches, but sharpening and noise reduction use a fixed pixel
  radius and come out slightly stronger in the preview.
- Clarity, noise reduction and the lens corrections are full-frame filters, so
  an export with those on costs a few seconds per photo at 24MP and up.
- The server binds to 127.0.0.1 and has no authentication. It only renders
  files that are in the open library, so another tab cannot use it to read the
  rest of the disk, but anything that can reach the port can drive the app.
