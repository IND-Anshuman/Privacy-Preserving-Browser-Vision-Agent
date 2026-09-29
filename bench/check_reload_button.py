"""Does the reload button fit the panel header at every supported width?

The side panel is 400px in Chrome but users can drag it narrower, and the
header is a flex row: mark + title + conn pill + reload button. The title has
`text-overflow: ellipsis` and should absorb the pressure, so the button must
never be the thing that pushes past the edge.

Measures the BUILT panel in headless Chrome at 400 / 360 / 320 px.

Note on the template below: it uses SINGLE braces and is injected with
str.replace, not str.format. Doubling the braces (as .format would require)
turns the JS object literals into `{{...}}`, which is a syntax error — and the
symptom is a probe that silently never writes its title.

Run:  ./.venv/Scripts/python.exe bench/check_reload_button.py
"""

from __future__ import annotations

import functools
import http.server
import json
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "out-verify" / "chrome-mv3"
WIDTHS = (400, 360, 320)

HOST = """<!doctype html>
<html><head><meta charset="utf-8"><title>VEILHOST</title>
<style>html,body{margin:0;background:#222}
iframe{border:0;display:block;background:#fff}</style></head>
<body>
<iframe id="f" src="/sidepanel.html" width="__W__" height="900"></iframe>
<script>
window.addEventListener('load', () => {
  setTimeout(() => {
    const f = document.getElementById('f');
    const d = f.contentDocument;
    if (!d) { document.title = 'VEILPROBE' + JSON.stringify({ error: 'no contentDocument' }); return; }
    const vw = d.documentElement.clientWidth;
    const hdr = d.querySelector('header');
    const btn = d.getElementById('reload');
    const conn = d.getElementById('conn');
    const title = d.querySelector('.title');
    const g = (e) => (e ? e.getBoundingClientRect() : null);
    const hb = g(hdr), bb = g(btn), cb = g(conn), tb = g(title);
    document.title = 'VEILPROBE' + JSON.stringify({
      vw: vw,
      hasBtn: !!btn,
      btnW: bb ? +bb.width.toFixed(1) : null,
      btnOver: bb ? +(bb.right - vw).toFixed(1) : null,
      connOver: cb ? +(cb.right - vw).toFixed(1) : null,
      headerOver: hb ? +(hb.right - vw).toFixed(1) : null,
      titleClipped: tb ? tb.right <= (bb ? bb.left : vw) + 0.5 : null,
      titleW: tb ? +tb.width.toFixed(1) : null,
      bodyScrollW: d.documentElement.scrollWidth,
    });
  }, 2500);
});
</script></body></html>
"""


def chrome() -> str | None:
    for p in (
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        shutil.which("chrome") or "",
        shutil.which("google-chrome") or "",
    ):
        if p and Path(p).exists():
            return p
    return None


def serve(root: Path, port: int) -> socketserver.TCPServer:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main() -> int:
    if not (OUT / "sidepanel.html").exists():
        print("  no build — cd extension && VEIL_OUT_DIR=./out-verify npx wxt build", file=sys.stderr)
        return 2
    binp = chrome()
    if not binp:
        print("  no Chrome found", file=sys.stderr)
        return 2

    failures: list[str] = []
    rows: list[dict] = []

    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        for item in OUT.iterdir():
            if item.is_dir():
                shutil.copytree(item, work / item.name, dirs_exist_ok=True)
            else:
                shutil.copy2(item, work / item.name)

        # The panel calls chrome.* at module scope. On a plain page `chrome` is
        # undefined, the module throws, and the iframe never settles — so the
        # host's load handler never runs and the probe silently produces nothing.
        panel = work / "sidepanel.html"
        html = panel.read_text(encoding="utf-8")
        stub = (
            "<script>"
            "window.chrome={runtime:{sendMessage:()=>Promise.resolve(),"
            "onMessage:{addListener:()=>{}}},"
            "storage:{local:{get:()=>Promise.resolve({}),"
            "set:()=>Promise.resolve()}}};"
            "window.fetch=()=>Promise.reject(new TypeError('Failed to fetch'));"
            "</script>"
        )
        panel.write_text(html.replace("<head>", "<head>" + stub, 1), encoding="utf-8")

        port = 8763
        httpd = serve(work, port)
        try:
            for w in WIDTHS:
                page = work / f"__probe{w}.html"
                page.write_text(HOST.replace("__W__", str(w)), encoding="utf-8")
                proc = subprocess.run(
                    [
                        binp, "--headless=new", "--disable-gpu",
                        "--virtual-time-budget=9000", "--dump-dom",
                        f"http://127.0.0.1:{port}/__probe{w}.html",
                    ],
                    capture_output=True, text=True, timeout=120,
                )
                m = re.search(r"VEILPROBE(\{.*?\})", proc.stdout, re.S)
                if not m:
                    tail = ((proc.stdout or "")[-160:] + " | " + (proc.stderr or "")[-160:]).strip()
                    failures.append(f"{w}px: probe did not run -> {tail[:180]}")
                    continue
                d = json.loads(m.group(1))
                if d.get("error"):
                    failures.append(f"{w}px: {d['error']}")
                    continue
                d["w"] = w
                rows.append(d)
        finally:
            httpd.shutdown()

    print("\n  RELOAD BUTTON FIT (built panel, real header)")
    print("  " + "=" * 64)
    print(f"  {'width':>6} {'btn':>6} {'title':>7} {'btnOver':>8} {'connOver':>9} {'hdrOver':>8} {'scrollW':>8}")
    for d in rows:
        print(
            f"  {d['w']:>6} {d['btnW']:>6} {d['titleW']:>7} "
            f"{d['btnOver']:>8} {d['connOver']:>9} {d['headerOver']:>8} {d['bodyScrollW']:>8}"
        )
    print()

    for d in rows:
        w = d["w"]
        if not d["hasBtn"]:
            failures.append(f"{w}px: reload button missing from the built panel")
            continue
        if d["btnOver"] is not None and d["btnOver"] > 0.5:
            failures.append(f"{w}px: button overflows by {d['btnOver']}px")
        if d["connOver"] is not None and d["connOver"] > 0.5:
            failures.append(f"{w}px: conn pill overflows by {d['connOver']}px")
        if d["headerOver"] is not None and d["headerOver"] > 0.5:
            failures.append(f"{w}px: header overflows by {d['headerOver']}px")
        if d["titleClipped"] is False:
            failures.append(f"{w}px: title does not yield space to the button")
        if d["btnW"] is not None and d["btnW"] < 20:
            failures.append(f"{w}px: button collapsed to {d['btnW']}px")
        # Nothing anywhere in the panel may force a horizontal scrollbar.
        if d["bodyScrollW"] is not None and d["bodyScrollW"] > d["vw"] + 1:
            failures.append(
                f"{w}px: panel scrolls horizontally ({d['bodyScrollW']} > {d['vw']})"
            )

    for f in failures:
        print(f"  FAIL  {f}")
    for w in WIDTHS:
        if not any(r["w"] == w for r in rows):
            print(f"  FAIL  {w}px: no measurement")

    print("  " + "=" * 64)
    if failures:
        print(f"  {len(failures)} reload-button check(s) FAILED")
        return 1
    print(f"  all reload-button checks passed at {', '.join(str(w) for w in WIDTHS)}px")
    return 0


if __name__ == "__main__":
    sys.exit(main())
