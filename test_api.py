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
    return d


def main():
    check("test DB is the temp one, not the user's library",
          str(A.DB_PATH).startswith(WORK), A.DB_PATH)

    d = make_library()
    server = serve()

    st, b = req("/api/open", {"folder": d, "recursive": True})
    photos = json.loads(b)["photos"]
    check("open scans the folder recursively", st == 200 and len(photos) == 4, (st, b[:200]))
    p0 = photos[0]["path"]

    st, b = req(q("/api/thumb", path=p0))
    check("thumb renders a JPEG", st == 200 and b[:2] == b"\xff\xd8", st)

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
    req("/api/mark", {"path": photos[3]["path"], "flag": 1})
    out = os.path.join(WORK, "out")
    body = {"dest": out, "action": "copy", "selection": "keep", "keep_structure": True}
    st, b = req("/api/export", body)
    done = json.loads([ln for ln in b.decode().splitlines() if '"done"' in ln][-1][5:])
    check("export streams progress and finishes", st == 200 and done["exported"] == 2, done)
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
    check("the other photos survive the prune", len(paths) == 3, paths)

    st, b = req("/api/save-copy", {"path": p0})
    check("save copy writes an edited JPEG next to the original",
          st == 200 and os.path.isfile(json.loads(b)["photo"]["path"]), (st, b[:200]))

    server.should_exit = True
    time.sleep(0.4)


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(WORK, ignore_errors=True)
    print("ok" if not FAILED else "FAILED: " + ", ".join(FAILED))
    raise SystemExit(1 if FAILED else 0)
