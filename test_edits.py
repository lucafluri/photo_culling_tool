"""Self-check for the non-destructive edit pipeline. Run: python test_edits.py"""
import io
import json
import math
import os
import tempfile
import xml.dom.minidom

from PIL import Image, ImageDraw
from app import (_apply_edits, _bake_to_jpeg, _edits_tag, _find_paint_offset,
                 _tone_lut, _write_xmp_sidecar, applied_edits)


def test_apply_edits():
    img = Image.new("RGB", (200, 100), "white")           # landscape 2:1

    assert _apply_edits(img, None).size == (200, 100)      # no edits = untouched
    assert _apply_edits(img, {}).size == (200, 100)

    assert _apply_edits(img, {"rot": 90}).size == (100, 200)   # 90° swaps W/H
    assert _apply_edits(img, {"rot": 180}).size == (200, 100)

    cropped = _apply_edits(img, {"crop": [0.25, 0.0, 0.75, 1.0]})
    assert cropped.size == (100, 100)                      # middle half width

    # rotate then crop: crop is applied in the rotated frame
    rc = _apply_edits(img, {"rot": 90, "crop": [0.0, 0.0, 1.0, 0.5]})
    assert rc.size == (100, 100)                           # 100x200 -> top half

    # enhancements keep dimensions and don't crash at extremes
    assert _apply_edits(img, {"bright": 0.2, "contrast": 2, "saturation": 0,
                              "sharpness": 3}).size == (200, 100)

    # fine rotation auto-crops to the largest inscribed rect: 200x100 at 5°
    fine = _apply_edits(img, {"fine": 5})
    assert fine.size == (193, 83)
    assert _apply_edits(img, {"fine": -5}).size == (193, 83)   # symmetric
    assert _apply_edits(img, {"fine": 0}).size == (200, 100)   # 0 = untouched

    # white balance: +1 warms (R up, B down), G untouched, size kept
    grey = Image.new("RGB", (10, 10), (100, 100, 100))
    warm = _apply_edits(grey, {"temp": 1})
    assert warm.size == (10, 10)
    assert warm.getpixel((5, 5)) == (130, 100, 70)
    cool = _apply_edits(grey, {"temp": -1})
    assert cool.getpixel((5, 5)) == (70, 100, 130)

    # full white balance: R and B move independently (not coupled like "temp")
    assert _apply_edits(grey, {"wbR": 1, "wbB": 0}).getpixel((5, 5)) == (130, 100, 100)
    assert _apply_edits(grey, {"wbR": 0, "wbB": -1}).getpixel((5, 5)) == (100, 100, 70)
    assert _apply_edits(grey, {"wbR": 1, "wbB": 1}).getpixel((5, 5)) == (130, 100, 130)   # same direction

    # auto-levels: flat image is a no-op, never crashes
    assert _apply_edits(grey, {"auto": True}).size == (10, 10)

    # border: 10% of the short edge (100) = 10px on every side
    bordered = _apply_edits(img, {"border": {"w": 0.1, "color": "#000000"}})
    assert bordered.size == (220, 120)
    assert bordered.getpixel((0, 0)) == (0, 0, 0)          # border color exact
    assert _apply_edits(img, {"border": {"w": 0}}).size == (200, 100)  # 0 = none

    # border is applied after crop, in the cropped frame
    cb = _apply_edits(img, {"crop": [0.25, 0.0, 0.75, 1.0],
                            "border": {"w": 0.1, "color": "#ffffff"}})
    assert cb.size == (120, 120)                           # 100x100 + 10px each side

    # _apply_edits must never mutate its input — the live-preview base cache
    # hands the same PIL image to every request
    base = Image.new("RGB", (60, 40), (10, 200, 30))
    before = base.tobytes()
    _apply_edits(base, {"rot": 90, "fine": 3, "crop": [0.1, 0.1, 0.9, 0.9],
                        "auto": True, "temp": 0.5, "bright": 1.4,
                        "sharpness": 2, "border": {"w": 0.1, "color": "#fff"}})
    assert base.tobytes() == before

    # tag is stable & order-independent, empty for falsy edits
    assert _edits_tag({}) == "" == _edits_tag(None)
    assert _edits_tag({"rot": 90, "bright": 1.5}) == _edits_tag({"bright": 1.5, "rot": 90})
    assert _edits_tag({"rot": 90}) != _edits_tag({"rot": 180})


def test_tone_lut():
    assert _tone_lut(0, 0, 0, 0, 0) == list(range(256))        # neutral = identity
    for args in ((1, 0, 0, 0, 0), (0, -1, 1, 0, 0), (0, 0, 0, 1, -1)):
        lut = _tone_lut(*args)
        assert all(0 <= v <= 255 for v in lut)
        assert all(lut[i] <= lut[i + 1] for i in range(255)), args   # never inverts tone
    # highlights/shadows leave the endpoints alone; whites/blacks are what move them
    assert _tone_lut(0, 1, 1, 0, 0)[0] == 0
    assert _tone_lut(0, -1, -1, 0, 0)[255] == 255
    assert _tone_lut(0, 0, 0, 0, 1)[0] > 0           # blacks +1 lifts the shadow point
    assert _tone_lut(1, 0, 0, 0, 0)[128] > 128       # +1 EV is brighter
    assert _tone_lut(-1, 0, 0, 0, 0)[128] < 128


def test_tone_and_colour():
    grey = Image.new("RGB", (16, 16), (100, 100, 100))

    assert _apply_edits(grey, {"exposure": 1}).getpixel((8, 8))[0] > 100
    assert _apply_edits(grey, {"exposure": -1}).getpixel((8, 8))[0] < 100
    assert _apply_edits(grey, {"shadows": 1}).getpixel((8, 8))[0] > 100
    bright = Image.new("RGB", (16, 16), (200, 200, 200))
    assert _apply_edits(bright, {"highlights": -1}).getpixel((8, 8))[0] < 200

    # black & white: equal channels out of a saturated input
    r, g, b = _apply_edits(Image.new("RGB", (8, 8), (200, 50, 50)), {"bw": True}).getpixel((4, 4))
    assert r == g == b

    # vibrance moves an unsaturated pixel more than an already-saturated one
    spread = lambda im: max(im.getpixel((4, 4))) - min(im.getpixel((4, 4)))
    flat = Image.new("RGB", (8, 8), (120, 110, 100))
    vivid = Image.new("RGB", (8, 8), (250, 10, 10))
    gain_flat = spread(_apply_edits(flat, {"vibrance": 1})) - spread(flat)
    gain_vivid = spread(_apply_edits(vivid, {"vibrance": 1})) - spread(vivid)
    assert gain_flat > 0
    assert gain_vivid < gain_flat

    # no tonal or effect stage may change the frame size
    for e in ({"clarity": 0.8}, {"clarity": -0.8}, {"denoise": 0.6},
              {"grain": 0.5}, {"vibrance": -1}, {"bw": True}, {"whites": 0.5}):
        assert _apply_edits(grey, e).size == (16, 16), e


def test_vignette():
    flat = Image.new("RGB", (101, 101), (200, 200, 200))
    dark = _apply_edits(flat, {"vignette": 1})
    assert dark.getpixel((50, 50)) == (200, 200, 200)       # centre untouched
    assert dark.getpixel((0, 0))[0] < 40                    # corners pulled down
    # negative = lens falloff correction: the corners come back *up*
    dim = Image.new("RGB", (101, 101), (100, 100, 100))
    assert _apply_edits(dim, {"vignette": -1}).getpixel((0, 0))[0] > 100


def test_lens_corrections():
    # every lens stage keeps the frame full — no black wedges left to crop off
    flat = Image.new("RGB", (300, 200), (180, 180, 180))
    for e in ({"distort": 0.3}, {"distort": -0.3}, {"ca": 1},
              {"persV": 0.5}, {"persV": -0.5}, {"persH": 0.5}):
        out = _apply_edits(flat, e)
        assert out.size == (300, 200), e
        for px in ((0, 0), (299, 0), (0, 199), (299, 199), (150, 100)):
            assert out.getpixel(px)[0] > 150, (e, px)
    # a line straight through the optical centre stays straight and stays put:
    # a radial correction only moves pixels along their own radius
    line = Image.new("RGB", (200, 200), "black")
    for x in range(200):
        line.putpixel((x, 100), (255, 255, 255))
    warped = _apply_edits(line, {"distort": 0.25})
    for x in (5, 100, 195):
        col = [warped.getpixel((x, y))[0] for y in range(95, 106)]
        assert max(col) > 200 and col.index(max(col)) == 5, (x, col)


def test_find_paint_offset():
    # a red blemish on flat sky with a busy stripe on the left: the search must
    # come back with an offset that clears the blemish and dodges the stripes
    im = Image.new("RGB", (400, 300), (90, 110, 130))
    for x in range(0, 120, 4):
        for y in range(300):
            im.putpixel((x, y), (240, 240, 40))      # high-variance stripes
    for x in range(190, 210):
        for y in range(140, 160):
            im.putpixel((x, y), (255, 0, 0))
    found = _find_paint_offset(im, [(200, 150)], 15)
    assert found is not None
    dx, dy = found[0] * 400, found[1] * 300
    assert math.hypot(dx, dy) > 2 * 15                  # source clear of the spot
    assert 200 + dx > 130                               # not sourced from the stripes

    # too small to hold a source area at all: says so instead of guessing
    assert _find_paint_offset(Image.new("RGB", (20, 20), "grey"), [(10, 10)], 8) is None

    # a long stroke can only be sourced from beside itself, never along itself
    line = Image.new("RGB", (400, 300), (90, 110, 130))
    ImageDraw.Draw(line).line([(60, 150), (340, 150)], fill=(255, 0, 0), width=12)
    pts = [(x, 150) for x in range(60, 341, 12)]
    off = _find_paint_offset(line, pts, 10)
    assert off is not None
    assert abs(off[1] * 300) > 10                       # displaced across the stroke


def test_retouch_stroke():
    # brushing along a blemish removes all of it, not just where it was clicked
    im = Image.new("RGB", (400, 300), (90, 110, 130))
    ImageDraw.Draw(im).line([(120, 150), (280, 150)], fill=(255, 0, 0), width=10)
    pts = [[x / 400.0, 150 / 300.0] for x in range(120, 285, 10)]
    off = _find_paint_offset(im, [(p[0] * 400, p[1] * 300) for p in pts], 9)
    out = _apply_edits(im, {"spots": [{"pts": pts, "r": 9 / 300.0,
                                       "dx": off[0], "dy": off[1]}]})
    near = lambda got, want: all(abs(a - b) <= 3 for a, b in zip(got, want))
    for x in (130, 200, 270):
        assert near(out.getpixel((x, 150)), (90, 110, 130)), x
    assert out.getpixel((5, 5)) == (90, 110, 130)        # nothing else touched


def test_retouch_over_the_edge():
    # a brush that hangs off the frame paints the part that is on it, rather
    # than being shoved inwards until it fits (which left corners unreachable)
    im = Image.new("RGB", (200, 200), (50, 60, 70))
    for x in range(14):
        for y in range(14):
            im.putpixel((x, y), (255, 0, 0))
    out = _apply_edits(im, {"spots": [{"pts": [[-0.02, -0.02], [0.03, 0.03]],
                                       "r": 0.09, "dx": 0.4, "dy": 0.4}]})
    assert out.size == (200, 200)
    assert out.getpixel((1, 1)) == (50, 60, 70)         # the very corner is fixed
    assert out.getpixel((199, 199)) == (50, 60, 70)     # and the rest is untouched


def test_retouch_entry_shapes():
    im = Image.new("RGB", (200, 200), (90, 110, 130))
    for x in range(95, 105):
        for y in range(95, 105):
            im.putpixel((x, y), (255, 0, 0))
    near = lambda got, want: all(abs(a - b) <= 3 for a, b in zip(got, want))

    # a single-point stroke is a spot
    assert near(_apply_edits(im, {"spots": [{"pts": [[0.5, 0.5]], "r": 0.06,
                                             "dx": -0.3, "dy": 0}]}).getpixel((100, 100)),
                (90, 110, 130))
    # spots written before the brush existed carry an absolute source point
    assert near(_apply_edits(im, {"spots": [{"x": 0.5, "y": 0.5, "r": 0.06,
                                             "sx": 0.2, "sy": 0.5}]}).getpixel((100, 100)),
                (90, 110, 130))
    # clone copies pixels as they are, heal takes the destination's colour
    dark = Image.new("RGB", (200, 200), (90, 110, 130))
    for x in range(60):
        for y in range(60):
            dark.putpixel((x, y), (20, 30, 40))
    for x in range(95, 105):
        for y in range(95, 105):
            dark.putpixel((x, y), (255, 0, 0))
    spot = {"pts": [[0.5, 0.5]], "r": 0.06, "dx": -0.35, "dy": -0.35}
    assert near(_apply_edits(dark, {"spots": [spot]}).getpixel((100, 100)), (90, 110, 130))
    assert near(_apply_edits(dark, {"spots": [dict(spot, mode="clone")]}).getpixel((100, 100)),
                (20, 30, 40))

    # malformed entries are skipped rather than fatal — edits come in over HTTP
    assert _apply_edits(im, {"spots": [{}, None, {"r": 0.1}, {"pts": []}]}).size == (200, 200)
    # an entry with no offset heals nothing rather than pasting onto itself
    assert _apply_edits(im, {"spots": [{"pts": [[0.5, 0.5]], "r": 0.06,
                                        "dx": 0, "dy": 0}]}).getpixel((100, 100)) == (255, 0, 0)


def test_full_stack_no_mutation():
    # the live-preview base cache hands the same PIL image to every request, so
    # not one of the stages may write into its input
    base = Image.new("RGB", (120, 90), (10, 200, 30))
    before = base.tobytes()
    _apply_edits(base, {
        "rot": 90, "flipH": True, "distort": 0.2, "ca": 0.5, "persV": 0.3,
        "fine": 3, "crop": [0.1, 0.1, 0.9, 0.9],
        "spots": [{"x": 0.5, "y": 0.5, "r": 0.1, "sx": 0.2, "sy": 0.2}],
        "exposure": 0.5, "highlights": -0.4, "shadows": 0.4, "whites": 0.2,
        "blacks": -0.2, "auto": True, "wbR": 0.3, "wbB": -0.3, "bright": 1.2,
        "contrast": 1.1, "vibrance": 0.5, "saturation": 1.3, "clarity": 0.5,
        "denoise": 0.3, "sharpness": 1.5, "bw": True, "vignette": 0.4,
        "grain": 0.2, "border": {"w": 0.05, "color": "#fff"},
    })
    assert base.tobytes() == before


def test_grain_is_deterministic():
    # renders are cached by a hash of the edits, so identical edits have to
    # produce identical pixels — an unseeded rng would quietly break that
    im = Image.new("RGB", (64, 3000), (128, 128, 128))    # tall enough to span strips
    a = _apply_edits(im, {"grain": 0.5})
    assert a.tobytes() == _apply_edits(im, {"grain": 0.5}).tobytes()
    assert a.tobytes() != im.tobytes()


def test_applied_edits():
    # adjustments the user switched off are stored so they can come back, but
    # they change no pixels — everything downstream has to look past them
    assert applied_edits(None) is None
    assert applied_edits({}) is None
    assert applied_edits({"off": {"exposure": 1}}) is None       # nothing live left
    assert applied_edits({"bw": True, "off": {"exposure": 1}}) == {"bw": True}

    grey = Image.new("RGB", (8, 8), (100, 100, 100))
    parked = {"off": {"exposure": 2, "bw": True}}
    assert _apply_edits(grey, parked).getpixel((4, 4)) == (100, 100, 100)
    assert _edits_tag(parked) == ""                              # not a distinct render
    assert _edits_tag({"bw": True}) == _edits_tag({"bw": True, "off": {"exposure": 1}})


def test_xmp_sidecar():
    with tempfile.TemporaryDirectory() as d:
        raw = os.path.join(d, "DSC_0001.NEF")
        open(raw, "wb").close()
        out = _write_xmp_sidecar(raw, {"exposure": 0.7, "bw": True,
                                       "off": {"vignette": 0.5}}, 4, 1)
        assert out == raw + ".xmp"
        text = io.open(out, encoding="utf-8").read()
        assert 'xmp:Rating="4"' in text
        assert 'xmp:Label="Keep"' in text
        assert "exposure" in text and "bw" in text
        assert "vignette" not in text          # parked, so not a change
        # the JSON lives inside an XML attribute: its quotes have to be escaped
        # or the sidecar is malformed and no reader will open it
        assert "&quot;" in text
        doc = xml.dom.minidom.parseString(
            text[text.index("<x:xmpmeta"):text.index("</x:xmpmeta>") + 12])
        desc = doc.getElementsByTagName("rdf:Description")[0]
        assert json.loads(desc.getAttribute("culler:Edits")) == {"exposure": 0.7, "bw": True}


def test_bake_to_jpeg():
    # export bakes the same transforms into a real JPEG on disk
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "in.png")
        Image.new("RGB", (200, 100), "white").save(src)
        out = os.path.join(d, "out.jpg")
        _bake_to_jpeg(src, out, {"rot": 90, "crop": [0.0, 0.0, 1.0, 0.5]}, 92)
        with Image.open(out) as im:
            assert im.format == "JPEG"
            assert im.size == (100, 100)     # 100x200 rotated frame, top half


if __name__ == "__main__":
    test_apply_edits()
    test_tone_lut()
    test_tone_and_colour()
    test_vignette()
    test_lens_corrections()
    test_find_paint_offset()
    test_retouch_stroke()
    test_retouch_over_the_edge()
    test_retouch_entry_shapes()
    test_full_stack_no_mutation()
    test_grain_is_deterministic()
    test_applied_edits()
    test_xmp_sidecar()
    test_bake_to_jpeg()
    print("ok")
