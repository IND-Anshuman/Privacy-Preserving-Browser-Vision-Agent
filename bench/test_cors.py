"""
CORS policy tests — the wildcard must be refused, not honoured.

CORS is a real control here, not a formality. The extension holds a capability
a web page does not: a redaction manifest and a server that will act on a
screen. `docker-compose.yml` shipped `VEIL_ALLOWED_ORIGINS: "*"`, which meant
any page the user visited could POST to the server and get a plan back.

Each case is checked in a SUBPROCESS, because the policy is computed at import
time and an in-process reimport would use a cached module.

    ./.venv/Scripts/python.exe bench/test_cors.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable

FAILS: list[str] = []
PASSES = 0


def run_with_origin(value: str | None) -> tuple[int, str, str]:
    """Import server.app with VEIL_ALLOWED_ORIGINS set; return (rc, out, err)."""
    env = dict(os.environ)
    env.pop("VEIL_ALLOWED_ORIGINS", None)
    if value is not None:
        env["VEIL_ALLOWED_ORIGINS"] = value
    env["PYTHONPATH"] = str(ROOT)
    p = subprocess.run(
        [PY, "-c", "import server.app as a; print('ALLOWED=', a._ALLOWED)"],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(ROOT),
        timeout=90,
    )
    return p.returncode, p.stdout, p.stderr


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASSES
    if ok:
        PASSES += 1
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))
        FAILS.append(name)


def main() -> None:
    print("\n  CORS POLICY")
    print("  " + "=" * 66)

    # 1. The bug: "*" must not start the server.
    rc, out, err = run_with_origin("*")
    check(
        'a "*" origin list is REFUSED (rc != 0)',
        rc != 0,
        f"rc={rc} out={out.strip()[:80]}",
    )
    check(
        "the refusal explains itself",
        "VEIL_ALLOWED_ORIGINS" in err,
        err.strip()[-120:],
    )

    # 2. A real extension origin is accepted verbatim.
    origin = "chrome-extension://abcdefghijklmnopqrstuvwxyz012345"
    rc, out, err = run_with_origin(origin)
    check(
        "an explicit extension origin is accepted",
        rc == 0 and origin in out,
        f"rc={rc} out={out.strip()[:100]} err={err.strip()[-100:]}",
    )

    # 3. Multiple origins, comma-separated.
    multi = "chrome-extension://aaa,moz-extension://bbb"
    rc, out, err = run_with_origin(multi)
    check(
        "a comma-separated list is accepted",
        rc == 0 and "chrome-extension://aaa" in out and "moz-extension://bbb" in out,
        f"rc={rc} out={out.strip()[:100]}",
    )

    # 4. "dev" allows extension origins but NOT http pages.
    rc, out, err = run_with_origin("dev")
    ok = rc == 0 and "chrome-extension://*" in out and "http" not in out.replace("http://", "@@")
    check(
        '"dev" allows extension origins but excludes web pages',
        ok,
        f"rc={rc} out={out.strip()[:120]}",
    )

    # 5. Unset is deny-by-default, and it must warn rather than fail.
    rc, out, err = run_with_origin(None)
    check(
        "unset starts with an empty allow-list (deny by default)",
        rc == 0 and "ALLOWED= []" in out,
        f"rc={rc} out={out.strip()[:100]}",
    )
    check(
        "unset warns the operator to configure it",
        "VEIL_ALLOWED_ORIGINS" in err,
        err.strip()[-120:],
    )

    # 6. Credentials are off, so a future origin addition cannot leak a cookie.
    rc, out, err = run_with_origin("dev")
    src = (ROOT / "server" / "app.py").read_text(encoding="utf-8")
    check(
        "allow_credentials is False",
        "allow_credentials=False" in src,
        "CORS credentials not explicitly disabled",
    )

    # 7. The compose file must not reintroduce the wildcard.
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    bad = [
        ln
        for ln in compose.splitlines()
        if "VEIL_ALLOWED_ORIGINS" in ln and '"*"' in ln
    ]
    check(
        "docker-compose does not set a wildcard origin",
        not bad,
        f"{bad}",
    )

    print("  " + "=" * 66)
    if FAILS:
        print(f"  {len(FAILS)} CORS check(s) FAILED\n")
        raise SystemExit(1)
    print(f"  all {PASSES} CORS checks passed\n")


if __name__ == "__main__":
    main()
