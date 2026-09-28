"""Static file server for the panel preview.

Why a file and not `node -e`: the inline form died with "stdin is not a tty"
every time it was backgrounded through this shell, which looked like the server
refusing to start rather than a harness quirk.

    ./.venv/Scripts/python.exe bench/serve_preview.py [--port 8125] [--dir ...]

Binds 0.0.0.0 and prints the LAN address as well as localhost, because the
browser automation used for review refuses private/loopback addresses and a
preview that cannot be opened is not a preview.
"""

from __future__ import annotations

import argparse
import http.server
import os
import socket
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / "extension" / (".review/chrome-mv3" if (ROOT / "extension" / ".review" / "chrome-mv3" / "sidepanel.html").exists() else ".output/chrome-mv3")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".html": "text/html",
        ".json": "application/json",
        ".css": "text/css",
        ".webp": "image/webp",
    }

    def log_message(self, *a) -> None:  # quiet
        pass

    def end_headers(self) -> None:
        # The panel is a module; a cached copy makes an edit look like it had no
        # effect, which is a genuinely confusing thing to debug.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8125)
    ap.add_argument("--dir", default=str(DEFAULT))
    args = ap.parse_args()

    d = Path(args.dir)
    if not (d / "panel_preview.html").exists():
        print(f"  no panel_preview.html in {d}", file=sys.stderr)
        print("  build it:  cd extension && npx wxt build", file=sys.stderr)
        print("             ./.venv/Scripts/python.exe bench/make_panel_preview.py", file=sys.stderr)
        return 2

    os.chdir(d)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    with Server(("0.0.0.0", args.port), Handler) as httpd:
        print(f"  serving {d}")
        print(f"    http://127.0.0.1:{args.port}/panel_preview.html?state=confirm")
        print(f"    http://{lan_ip()}:{args.port}/panel_preview.html?state=confirm")
        print("  states: empty | busy | confirm | full    (ctrl-c to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
