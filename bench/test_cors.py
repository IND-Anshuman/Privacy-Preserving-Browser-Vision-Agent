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


def preflight(origin: str, port: int = 8199) -> tuple[int, str]:
    """Send a REAL CORS preflight and return (status, allow-origin).

    The existing checks in this file assert on the parsed `_ALLOWED` list, which
    is a VARIABLE, not behaviour — and that is how the `dev` bug survived a
    green suite. `dev` expanded to `["chrome-extension://*"]`, Starlette does
    exact string matching with no glob support, so that list matched nothing and
    every request was blocked. The variable looked correct; the preflight
    returned 400 with no `access-control-allow-origin`.

    So these cases start a real server and ask the browser's actual question.

    The port is deliberately unusual. The first version used 8123, which
    happened to be occupied by a leftover preview server from another task, so
    every preflight got that server's 404 and all three checks failed for a
    reason that had nothing to do with CORS. A liveness check that passes
    against the WRONG process is worse than no check: it looks like a result.
    """
    env = dict(os.environ)
    env["VEIL_ALLOWED_ORIGINS"] = "dev"
    env["PYTHONPATH"] = str(ROOT)
    # This suite is about CORS headers, not about reaching a model. Without
    # these, `server.app` loads the operator's real .env and every /health poll
    # probes the live endpoint — which turned a 2-second header check into a
    # 300-second timeout, and reported it as a CORS failure.
    #
    # The same pinning bench/test_server.py needs, for the same reason: a suite
    # that inherits production credentials stops being a unit test.
    env["VEIL_LLM_PROVIDER"] = "fake"
    env["VEIL_ENV_FILE"] = str(ROOT / "bench" / ".no-such-env-file")
    code = (
        "import uvicorn, server.app as a\n"
        f"uvicorn.run(a.app, host='127.0.0.1', port={port}, log_level='error')\n"
    )
    proc = subprocess.Popen(
        [PY, "-c", code], env=env, cwd=str(ROOT),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        import time

        import httpx

        base = f"http://127.0.0.1:{port}"
        up = False
        for _ in range(60):
            if proc.poll() is not None:
                return -1, f"(our server exited rc={proc.returncode})"
            try:
                # Confirm it is OUR server, not a squatter: /health reports the
                # provider list, which only this app produces.
                h = httpx.get(f"{base}/health", timeout=2.0)
                if h.status_code == 200 and "providers" in h.json():
                    up = True
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.5)
        if not up:
            return -1, "(our server never became ready)"

        r = httpx.options(
            f"{base}/v1/agent/step",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
            timeout=10.0,
        )
        return r.status_code, r.headers.get("access-control-allow-origin", "(none)")
    except Exception as e:  # noqa: BLE001
        return -1, f"error:{type(e).__name__}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


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
    # 4. "dev" must compile to a REGEX, not a glob. Starlette compares the
    #    request Origin by exact string match and has no wildcard support, so
    #    the previous `["chrome-extension://*"]` matched NOTHING — the extension
    #    was fully blocked while this variable still looked correct.
    rc, out, err = run_with_origin("dev")
    check(
        '"dev" compiles to a REGEX handed to allow_origin_regex, not a glob',
        rc == 0 and "chrome-extension://*" not in out,
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

    # 8. BEHAVIOUR, not configuration. Everything above inspects a variable or a
    #    string; these start a real server and send the preflight a browser
    #    sends. The `dev` case above PASSED while the extension was completely
    #    blocked in practice, which is the whole reason these exist.
    print("\n  CORS BEHAVIOUR (real preflights against a live server)")
    chrome_ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    firefox_ext = "moz-extension://abcdef12-3456-7890-abcd-ef1234567890"
    webpage = "https://evil.example.com"

    code, allow = preflight(chrome_ext)
    check(
        "dev mode ACTUALLY allows a chrome-extension origin",
        code == 200 and allow == chrome_ext,
        f"preflight {code} allow-origin={allow!r}",
    )

    code, allow = preflight(firefox_ext)
    check(
        "dev mode ACTUALLY allows a firefox-extension origin",
        code == 200 and allow == firefox_ext,
        f"preflight {code} allow-origin={allow!r} "
        f"(moz ids use dashes, so a-z-only regex rejects them)",
    )

    code, allow = preflight(webpage)
    check(
        "dev mode ACTUALLY refuses an http/https page",
        code == 400 and allow == "(none)",
        f"preflight {code} allow-origin={allow!r}",
    )

    print("  " + "=" * 66)
    if FAILS:
        print(f"  {len(FAILS)} CORS check(s) FAILED\n")
        raise SystemExit(1)
    print(f"  all {PASSES} CORS checks passed\n")


if __name__ == "__main__":
    main()
