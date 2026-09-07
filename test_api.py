"""End-to-end check of the HTTP API against a throwaway library.

Boots the real app on a spare port with its DB and cache redirected to a temp
dir, then drives it over HTTP. Run: python test_api.py
"""
import json
import os
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# must be set before app is imported — it resolves APP_HOME at import time
WORK = tempfile.mkdtemp(prefix="culler_test_")
os.environ["PHOTO_CULLER_HOME"] = os.path.join(WORK, "home")

from PIL import Image                                    # noqa: E402
import app as A                                          # noqa: E402

PORT = 8123
BASE = "http://127.0.0.1:{}".format(PORT)
FAILED = []


def check(label, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + label, "" if cond else detail)
    if not cond:
        FAILED.append(label)


def req(path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    r = urllib.request.Request(BASE + path, data=data, headers=h)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def q(endpoint, **params):
    return endpoint + "?" + urllib.parse.urlencode(params)


def serve():
    import uvicorn
    server = uvicorn.Server(uvicorn.Config(A.app, host="127.0.0.1", port=PORT,
                                           log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(60):
        try:
            urllib.request.urlopen(BASE + "/api/state", timeout=1)
            return server
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("server did not start")


def make_library():
    d = os.path.join(WORK, "shoot")
    os.makedirs(os.path.join(d, "sub"))
    names = ["a.jpg", "b&'.jpg", "c.png", os.path.join("sub", "d.jpg")]
    for i, n in enumerate(names):
        Image.new("RGB", (300, 200), (40 * i % 255, 90, 160)).save(os.path.join(d, n))
    # a stand-in negative beside a.jpg: never decoded by the tests, only routed
    open(os.path.join(d, "a.cr2"), "wb").write(b"not really a raw")
    return d


def main():
    check("test DB is the temp one, not the user's library",
          str(A.DB_PATH).startswith(WORK), A.DB_PATH)

    d = make_library()
    server = serve()

    st, b = req("/api/open", {"folder": d, "recursive": True})
    photos = json.loads(b)["photos"]
    check("open scans the folder recursively", st == 200 and len(photos) == 5, (st, b[:200]))
    p0 = next(p["path"] for p in photos if p["path"].endswith("a.jpg"))

    st, b = req(q("/api/thumb", path=p0))
    check("thumb renders a JPEG", st == 200 and b[:2] == b"\xff\xd8", st)

    # RAW-source grid thumbs ask for full=1; on a non-RAW it must fall back
    # instead of handing libraw a JPEG
    st, b = req(q("/api/thumb", path=p0, full=1))
    check("thumb full=1 falls back on a non-RAW", st == 200 and b[:2] == b"\xff\xd8", st)

    # A live editor preview is a fast draft off a downscaled base. It must not
    # be reused as the committed render for the same edits — that would leave a
    # cropped photo permanently soft.
    edits = {"bright": 1.4, "crop": [0.1, 0.1, 0.6, 0.6]}
    st, draft = req(q("/api/preview", path=p0, edits=json.dumps(edits)))
    check("live preview renders", st == 200 and draft[:2] == b"\xff\xd8", st)
    req("/api/edit", {"path": p0, "edits": edits})
    st, stored = req(q("/api/preview", path=p0))
    check("committed preview is not the draft", stored != draft, (len(draft), len(stored)))

    st, b = req(q("/api/meta", path=p0))
    check("meta reads dimensions", st == 200 and json.loads(b)["width"] == 300, b[:200])

    # export: structure kept, edits baked, nothing overwritten on a second run
    req("/api/mark", {"path": p0, "flag": 1})
    req("/api/mark", {"path": os.path.join(d, "sub", "d.jpg"), "flag": 1})
    req("/api/mark", {"path": os.path.join(d, "a.cr2"), "flag": 1})
    # the UI mirrors a group's edits onto every member, negative included —
    # that must not be read as "render me a JPEG off this negative"
    req("/api/edit", {"path": os.path.join(d, "a.cr2"), "edits": edits})
    out = os.path.join(WORK, "out")
    # neither RAW switch on: the edited JPEG goes out, its negative doesn't
    body = {"dest": out, "action": "copy", "selection": "keep", "keep_structure": True,
            "raw_jpeg": False, "raw_copy": False}
    st, b = req("/api/export", body)
    done = json.loads([ln for ln in b.decode().splitlines() if '"done"' in ln][-1][5:])
    check("export streams progress and finishes", st == 200 and done["exported"] == 2, done)
    check("both RAW switches off skips the negative",
          not any(f.lower().endswith((".cr2", "_raw.jpg")) for f in os.listdir(out)),
          os.listdir(out))
    out2 = os.path.join(WORK, "out_raw")
    st, b = req("/api/export", dict(body, dest=out2, raw_copy=True))
    done2 = json.loads([ln for ln in b.decode().splitlines() if '"done"' in ln][-1][5:])
    check("raw_copy on still exports the negative",
          done2["exported"] == 3 and os.path.isfile(os.path.join(out2, "a.cr2")),
          (done2["exported"], os.listdir(out2)))
    check("an edited negative alone doesn't render a _raw.jpg",
          not done2["errors"] and
          not any(f.endswith("_raw.jpg") for f in os.listdir(out2)),
          (done2["errors"], os.listdir(out2)))
    check("keep_structure preserves the subfolder",
          os.path.isfile(os.path.join(out, "sub", "d.jpg")), os.listdir(out))
    check("edited photo exports as a baked JPEG",
          os.path.isfile(os.path.join(out, os.path.basename(p0))), os.listdir(out))
    req("/api/export", body)
    check("re-export renames instead of overwriting",
          any(f.endswith("_1.jpg") for f in os.listdir(os.path.join(out, "sub"))),
          os.listdir(os.path.join(out, "sub")))

    # a page on another origin must not be able to move or delete your photos
    st, _ = req("/api/delete-rejected", {"confirm": False},
                headers={"Origin": "http://evil.example"})
    check("cross-site POST is blocked", st == 403, st)
    st, _ = req("/api/delete-rejected", {"confirm": False},
                headers={"Origin": BASE})
    check("same-origin POST is allowed", st == 200, st)

    # rows for files that vanished from disk are dropped on rescan
    os.remove(os.path.join(d, "c.png"))
    req("/api/open", {"folder": d, "recursive": True})
    st, b = req("/api/state")
    paths = [p["path"] for p in json.loads(b)["photos"]]
    check("deleted file is pruned from the DB",
          not any(p.endswith("c.png") for p in paths), paths)
    check("the other photos survive the prune", len(paths) == 4, paths)

    st, b = req("/api/save-copy", {"path": p0})
    check("save copy writes an edited JPEG next to the original",
          st == 200 and os.path.isfile(json.loads(b)["photo"]["path"]), (st, b[:200]))

    # The render endpoints take a filesystem path, and any page the browser
    # visits can point an <img> at them. Only files in the library may be read.
    outsider = os.path.join(WORK, "outsider.jpg")
    Image.new("RGB", (40, 40), "red").save(outsider)
    st, _ = req(q("/api/thumb", path=outsider))
    check("thumb refuses a path outside the library", st == 404, st)
    st, _ = req(q("/api/preview", path=outsider))
    check("preview refuses a path outside the library", st == 404, st)
    st, _ = req(q("/api/meta", path=outsider))
    check("meta refuses a path outside the library", st == 404, st)

    # a file that libraw can't read must report itself, not 500. (The stand-in
    # negative in this library is a text file, which is exactly that case.)
    st, b = req(q("/api/preview", path=os.path.join(d, "a.cr2"), full=1))
    check("an undecodable negative reports 422, not a crash",
          st == 422 and b"could not decode" in b, (st, b[:160]))

    # one request marks a whole selection, and reports what it touched
    sel = [p for p in paths if p.endswith((".jpg", ".cr2"))][:3]
    st, b = req("/api/mark", {"paths": sel, "rating": 4})
    body = json.loads(b)
    check("bulk mark updates every path in one call",
          st == 200 and body["marked"] == len(sel) and
          all(r["rating"] == 4 for r in body["photos"]), (st, b[:200]))

    # "export what I picked in the grid" — an explicit list, still fenced to
    # the open folder so a stale selection can't reach outside it
    out3 = os.path.join(WORK, "out_sel")
    st, b = req("/api/export", {"dest": out3, "action": "copy", "selection": "selected",
                                "paths": sel[:2], "raw_copy": True})
    done3 = json.loads([ln for ln in b.decode().splitlines() if '"done"' in ln][-1][5:])
    check("export of an explicit selection takes only those files",
          st == 200 and done3["exported"] == 2, (st, done3))
    st, _ = req("/api/export", {"dest": out3, "selection": "selected",
                                "paths": [outsider]})
    check("export of a selection outside the folder exports nothing",
          st == 200, st)
    check("...and wrote no extra files", len(os.listdir(out3)) == 2, os.listdir(out3))

    server.should_exit = True
    time.sleep(0.4)


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(WORK, ignore_errors=True)
    print("ok" if not FAILED else "FAILED: " + ", ".join(FAILED))
    raise SystemExit(1 if FAILED else 0)
