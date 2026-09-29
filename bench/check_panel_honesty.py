"""Does the panel tell the truth when the server is DOWN?

The status dot used to render 'ready' from local run state alone (`busy` /
`confirm`), so the panel claimed a connection it had never made. This drives the
BUILT panel with a stubbed chrome API, a rejecting fetch, and asserts the dot
reports the failure.

Method follows check_panel_layout.py: headless Chrome + --dump-dom, with the
result smuggled back through document.title. Puppeteer is not installed, and
`node -e` from a temp dir cannot resolve it.

Run:  ./.venv/Scripts/python.exe bench/check_panel_honesty.py
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

# The panel talks to its own origin over fetch, so it must be served over http,
# not file:// — file:// makes every fetch a cross-origin null request.
HOST_PAGE = """<!doctype html><html><head><title>pending</title></head><body>
<script>
window.addEventListener('error', e => {
  document.title = 'VEILPROBE' + JSON.stringify({ error: String(e.message) });
});
</script>
<iframe id="f" src="/sidepanel.html" style="width:400px;height:900px;border:0"></iframe>
<script>
(async () => {
  try {
    const f = document.getElementById('f');
    const w = f.contentWindow;
    // The panel runs its boot + health probe on load. Give it time.
    await new Promise(r => setTimeout(r, 2500));
    const d = w.document;
    const g = id => { const el = d.getElementById(id); return el ? el.textContent.trim() : null; };
    document.title = 'VEILPROBE' + JSON.stringify({
      conn: g('conn'), provider: g('p-provider'), pass: g('p-pass'), mode: g('p-mode'),
    });
  } catch (e) {
    document.title = 'VEILPROBE' + JSON.stringify({ error: String(e && e.message || e) });
  }
})();
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


def chunk_name() -> str:
    cands = sorted((OUT / "chunks").glob("sidepanel-*.js"))
    if not cands:
        raise SystemExit(f"no sidepanel chunk in {OUT / 'chunks'} — build first")
    return cands[0].name


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

    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        # Copy the built panel, then make the fetch fail and kill storage, so
        # the only honest outcome is "unreachable".
        for item in OUT.iterdir():
            if item.is_dir():
                shutil.copytree(item, work / item.name, dirs_exist_ok=True)
            else:
                shutil.copy2(item, work / item.name)

        # Inject the stubs at the very top of the panel document.
        panel = work / "sidepanel.html"
        html = panel.read_text(encoding="utf-8")
        stub = (
            "<script>"
            "window.chrome={runtime:{sendMessage:()=>Promise.resolve(),"
            "onMessage:{addListener:()=>{}}},"
            "storage:{local:{get:()=>Promise.reject(new Error('no storage')),"
            "set:()=>Promise.resolve()}}};"
            "window.fetch=()=>Promise.reject(new TypeError('Failed to fetch'));"
            "</script>"
        )
        html = html.replace("<head>", "<head>" + stub, 1)
        panel.write_text(html, encoding="utf-8")

        (work / "__probe.html").write_text(HOST_PAGE, encoding="utf-8")

        port = 8761
        httpd = serve(work, port)
        try:
            proc = subprocess.run(
                [
                    binp, "--headless=new", "--disable-gpu",
                    "--virtual-time-budget=9000", "--dump-dom",
                    f"http://127.0.0.1:{port}/__probe.html",
                ],
                capture_output=True, text=True, timeout=120,
            )
        finally:
            httpd.shutdown()

    m = re.search(r"VEILPROBE(\{.*?\})", proc.stdout, re.S)
    if not m:
        print("  FAIL  panel probe did not run")
        print("  ", proc.stdout[-300:], proc.stderr[-300:])
        return 1
    got = json.loads(m.group(1))
    if got.get("error"):
        print(f"  FAIL  probe error: {got['error']}")
        return 1

    # Every field must be a real string. The first run pointed the iframe at a
    # non-existent panel.html, so all four read None and two checks "passed" on
    # the absence of a value. A liveness check that passes on missing data is
    # worse than no check.
    missing = [k for k, v in got.items() if not isinstance(v, str) or not v.strip()]
    if missing:
        print(f"  FAIL  panel did not render: empty/missing {missing}")
        return 1

    checks = [
        ("dot does NOT claim ready", "ready" not in (got["conn"] or "").lower()),
        ("dot reports unreachable", "unreachable" in (got["conn"] or "").lower()),
        ("provider row admits failure", "unreachable" in (got["provider"] or "").lower()),
        ("password claim is computed, not the old static string",
         got["pass"] != "never sent, in any mode"),
    ]

    print("\n  PANEL HONESTY (server deliberately down)")
    print("  " + "=" * 62)
    for k, v in got.items():
        print(f"  {k:9} = {v!r}")
    print()
    ok = True
    for name, cond in checks:
        print(f"  {'PASS' if cond else 'FAIL'}  {name}")
        ok = ok and cond
    print("  " + "=" * 62)
    print(f"  {'all panel honesty checks passed' if ok else 'panel honesty FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
