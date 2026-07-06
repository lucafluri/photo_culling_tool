"""Self-check for the non-destructive edit pipeline. Run: python test_edits.py"""
import os
import tempfile

from PIL import Image
from app import _apply_edits, _bake_to_jpeg, _edits_tag


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
    test_bake_to_jpeg()
    print("ok")
