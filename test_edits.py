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
