"""Assert the side panel has no horizontal overflow, at real panel widths.

WHY A SCRIPT AND NOT A SCREENSHOT
---------------------------------
A screenshot review of this panel reported "clipped at the right edge" three
times while the layout was fine, and then reported the same after a fix that had
worked. The reason is instructive: the page background and the cards are both
near-white, so a pixel scan cannot distinguish a card's right border from the
page continuing past it, and a vision model reading the image inherits that
ambiguity.

`getBoundingClientRect` cannot be confused. This asks the layout engine where
each container's right edge actually is, and fails if any exceeds the viewport.

THE VIEWPORT TRAP
-----------------
The first version of this check reported a pass while the page was 504px wide
at every requested size. Chrome's `--window-size` sets the WINDOW, and headless
window chrome is subtracted from it. So the probe measured a 504px viewport,
found nothing overflowing inside 504px, and called it a pass at "400px".

The fix is a host page with a real 400px iframe: a side panel IS an iframe of
roughly that width, and an iframe's width does not depend on window chrome.

    cd extension && VEIL_OUT_DIR=.review npx wxt build
    ./.venv/Scripts/python.exe bench/make_panel_preview.py
    ./.venv/Scripts/python.exe bench/serve_preview.py --port 8741
    ./.venv/Scripts/python.exe bench/check_panel_layout.py --port 8741

Exits non-zero on overflow, so it can gate a commit.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVED = ROOT / "extension" / ".review" / "chrome-mv3"
WIDTHS = (400, 360, 320)  # a real panel, a narrow one, and the floor
STATES = ("empty", "busy", "confirm", "full")

HOST = """<!doctype html>
<html><head><meta charset="utf-8"><title>VEILHOST</title>
<style>html,body{{margin:0;background:#222}}
iframe{{border:0;display:block;background:#fff}}</style></head>
<body>
<iframe id="f" src="./{src}?state={state}" width="{w}" height="900"></iframe>
<script>
window.addEventListener('load', () => {{
  setTimeout(() => {{
    const f = document.getElementById('f')
    const d = f.contentDocument
    if (!d) {{ document.title = 'VEILPROBE' + JSON.stringify({{ error: 'no contentDocument' }}); return }}
    const vw = d.documentElement.clientWidth
    const sel = '.card,.confirm,.msg .body,button,.field,.stat,.panel,.thread,.row,.wf,.pill,.steps,.empty'
    const out = []
    for (const el of d.querySelectorAll(sel)) {{
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      out.push({{
        sel: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
        left: +r.left.toFixed(1), right: +r.right.toFixed(1),
        over: +(r.right - vw).toFixed(1),
        txt: (el.textContent || '').trim().slice(0, 24),
      }})
    }}
    const bad = out.filter((o) => o.over > 0.5).sort((a, b) => b.over - a.over)
    document.title = 'VEILPROBE' + JSON.stringify({{
      vw, scrollW: d.documentElement.scrollWidth, bodyScrollW: d.body.scrollWidth,
      count: bad.length, worst: bad.slice(0, 5),
      rightmost: out.length ? Math.max(...out.map((o) => o.right)) : 0,
      widest: out.length ? Math.max(...out.map((o) => o.right - o.left)) : 0,
    }})
  }}, 1600)
}})
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8741)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    if not (SERVED / "panel_preview.html").exists():
        print("  no panel_preview.html — build it:", file=sys.stderr)
        print("    cd extension && VEIL_OUT_DIR=.review npx wxt build", file=sys.stderr)
        print("    ./.venv/Scripts/python.exe bench/make_panel_preview.py", file=sys.stderr)
        return 2

    binp = chrome()
    if not binp:
        print("  no Chrome found; cannot measure", file=sys.stderr)
        return 2

    base = f"http://{args.host}:{args.port}"
    failures: list[str] = []
    checked = 0

    with tempfile.TemporaryDirectory() as td:
        host_page = SERVED / "__layout_probe.html"
        for state in STATES:
            for width in WIDTHS:
                host_page.write_text(
                    HOST.format(src="panel_preview.html", state=state, w=width),
                    encoding="utf-8",
                )
                checked += 1
                proc = subprocess.run(
                    [
                        binp,
                        "--headless=new",
                        "--disable-gpu",
                        "--allow-file-access-from-files",
                        f"--window-size={width + 40},1000",
                        "--virtual-time-budget=7000",
                        "--dump-dom",
                        f"{base}/__layout_probe.html",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=90,
                )
                m = re.search(r"VEILPROBE(\{.*?\})</title>", proc.stdout, re.S)
                if not m:
                    failures.append(f"{state}@{width}px: probe did not run")
                    continue
                data = json.loads(m.group(1))
                if data.get("error"):
                    failures.append(f"{state}@{width}px: {data['error']}")
                    continue
                if data["count"]:
                    for b in data["worst"]:
                        failures.append(
                            f"{state}@{width}px: {b['sel']} overflows by {b['over']}px "
                            f"(right={b['right']} of {data['vw']})  “{b['txt']}”"
                        )
                else:
                    print(
                        f"    {state:8}@{width:>3}px  viewport={data['vw']:>4}  "
                        f"rightmost={data['rightmost']:>6}  widest={data['widest']:>6}  "
                        f"scrollW={data['scrollW']}"
                    )
        try:
            host_page.unlink()
        except OSError:
            pass

    print("=" * 74)
    print(f"  PANEL LAYOUT — {checked} viewport/state combinations")
    print("=" * 74)
    if failures:
        print(f"  {len(failures)} OVERFLOW(S):")
        for f in failures[:24]:
            print(f"    {f}")
        return 1
    print(f"  contained at {', '.join(str(w) for w in WIDTHS)}px across {', '.join(STATES)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
