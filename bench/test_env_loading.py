"""
The server must see the operator's .env, whichever way it is started.

DEFECT
------
`server/app.py` did `router = Router()` at MODULE IMPORT, and each provider
snapshots `os.environ` into `self.base_url` / `self.api_key` / `self.model` in
its `__init__`. So the configuration is read exactly once, at import time.

`uvicorn --env-file .env` populates the environment AFTER the app module is
imported. Every provider therefore captured an EMPTY base_url and no key, and
fell back to `http://127.0.0.1:8001`. With nothing listening there, /health
reported "no provider reachable" and /v1/agent/step returned action:none —
forever, regardless of how correct the .env was.

The documented start command in README.md was therefore incapable of working.
That is worse than a crash: it looked configured and behaved unconfigured.

THE FIX
-------
Load .env into `os.environ` before the singletons are constructed, so import
order no longer decides whether the operator's configuration applies. Explicit
`VEIL_*` variables already in the environment keep winning, so a test harness
that sets them is not overridden by the file.

    cd C:/Users/HP/Desktop/Privacy-Preserving-Browser-Vision-Agent
    ./.venv/Scripts/python.exe bench/test_env_loading.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))


def write_env(path: Path, *, base: str, model: str, key: str) -> None:
    path.write_text(
        "\n".join([
            f"VEIL_LLM_PROVIDER=openai",
            f"VEIL_LLM_BASE_URL={base}",
            f"VEIL_LLM_MODEL={model}",
            f"VEIL_LLM_API_KEY={key}",
            "VEIL_LLM_MODE=strict",
            "",
        ]),
        encoding="utf-8",
    )


def child_env(path: Path) -> dict:
    """A clean environment with nothing pre-set, so .env is the only source."""
    e = {k: v for k, v in os.environ.items() if not k.startswith("VEIL_")}
    e["VEIL_ENV_FILE"] = str(path)
    return e


SNIPPET = textwrap.dedent("""
    import os, sys, json
    from pathlib import Path
    # Mirror what the app does, in a fresh interpreter.
    for line in Path(os.environ["VEIL_ENV_FILE"]).read_text().splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, _, v = s.partition("=")
            os.environ.setdefault(k.strip(), v.strip())
    from server.providers.openai_compat import OpenAICompatProvider
    p = OpenAICompatProvider()
    print(json.dumps({"base_url": p.base_url, "model": p.model,
                      "has_key": bool(p.api_key)}))
""")


def run_child(env: dict) -> dict:
    p = subprocess.run([sys.executable, "-c", SNIPPET], cwd=str(ROOT), env=env,
                       capture_output=True, text=True, timeout=180)
    line = [l for l in p.stdout.splitlines() if l.startswith("{")]
    if not line:
        raise RuntimeError(p.stderr[-800:] or p.stdout[-800:])
    import json
    return json.loads(line[-1])


def main() -> int:
    import json
    import tempfile

    print("\n  ENV LOADING — the operator's .env must actually reach the provider")
    print("  " + "-" * 66)

    with tempfile.TemporaryDirectory() as td:
        envfile = Path(td) / ".env"
        write_env(envfile, base="https://example.invalid/v1",
                  model="Qwen/Qwen3-VL-8B-Instruct", key="k" * 67)

        # 1. .env supplies the configuration when nothing else does.
        got = run_child(child_env(envfile))
        check("base_url comes from .env", got["base_url"] == "https://example.invalid/v1",
              f"got {got['base_url']!r}")
        check("model comes from .env", got["model"] == "Qwen/Qwen3-VL-8B-Instruct",
              f"got {got['model']!r}")
        check("api key comes from .env", got["has_key"] is True, f"got {got['has_key']!r}")

        # 2. An explicit environment variable still wins over the file.
        e2 = child_env(envfile)
        e2["VEIL_LLM_BASE_URL"] = "http://127.0.0.1:9999/v1"
        got2 = run_child(e2)
        check("an explicit env var overrides .env",
              got2["base_url"] == "http://127.0.0.1:9999/v1",
              f"got {got2['base_url']!r}")

        # 3. The module-level singleton in app.py must not be built before .env.
        src = (ROOT / "server" / "app.py").read_text(encoding="utf-8")
        has_loader = "load_dotenv" in src or "_load_env_file" in src
        check("app.py loads .env before building the Router", has_loader,
              "no .env loader in app.py, so `Router()` at import time sees an "
              "empty environment regardless of --env-file")
        # The loader must appear BEFORE `router = Router()`.
        if has_loader:
            i_load = min((src.index(k) for k in ("load_dotenv", "_load_env_file")
                          if k in src), default=-1)
            i_router = src.find("router = Router()")
            check("the loader runs before `router = Router()`",
                  i_load != -1 and i_load < i_router,
                  f"loader at {i_load}, router at {i_router}")

        # 4. /health must not claim "no provider reachable" before anything
        #    has been resolved. `active()` only reads a flag set by resolve(),
        #    so on a freshly started server it is always None.
        health_src = (ROOT / "server" / "app.py").read_text(encoding="utf-8")
        i_h = health_src.find("async def health")
        body = health_src[i_h : i_h + 1400]
        check("/health resolves the router instead of reading a stale flag",
              "await router.resolve()" in body,
              "/health calls router.active(), which only reflects a PREVIOUS "
              "resolve(); on a fresh server it is always None, so a correctly "
              "configured provider is reported as unreachable")
        check("the provider model is reported from the resolved provider",
              "active.model_name()" in body or "active = await router.resolve()" in body)

    print("\n  " + "-" * 66)
    print(f"  {PASS}/{PASS + FAIL} passed\n")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
