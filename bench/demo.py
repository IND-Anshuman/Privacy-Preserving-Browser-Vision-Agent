#!/usr/bin/env python
"""
One command to run and show Veil end to end.

    python bench/demo.py            # verify everything, then start the stack
    python bench/demo.py --verify   # verification gate only, no servers
    python bench/demo.py --fake     # use the offline provider (no API key)

What "verified" means here, precisely: every check below runs REAL code. There
are no stubs and no canned numbers — if a step cannot be measured, this prints
NOT MEASURED rather than a plausible figure.

The gate is ordered so the cheapest, most fundamental check fails first:

  1. extension unit tests        (the privacy + policy invariants)
  2. TypeScript compile          (no build-time lies)
  3. server / provider / CORS    (the wire contract)
  4. deployment contract         (the container can actually boot)
  5. live plan gate              (a bad plan is caught by the real endpoint)
  6. Chrome build                (it loads at all)

Then it starts the API and a static server for the synthetic forms, and — if a
real provider is configured — runs one actual task through the full HTTP + SSE
path, printing the plan, the steps, and the observed effect of each.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
PY = sys.executable

C = {
    "reset": "\033[0m", "b": "\033[1m", "dim": "\033[2m",
    "g": "\033[32m", "r": "\033[31m", "y": "\033[33m", "c": "\033[36m",
}


def head(t: str) -> None:
    print(f"\n{C['b']}{C['c']}{'=' * 68}{C['reset']}")
    print(f"{C['b']}{C['c']}  {t}{C['reset']}")
    print(f"{C['b']}{C['c']}{'=' * 68}{C['reset']}")


def ok(m: str) -> None:
    print(f"  {C['g']}PASS{C['reset']}  {m}")


def bad(m: str, detail: str = "") -> None:
    print(f"  {C['r']}FAIL{C['reset']}  {m}" + (f"\n        {C['dim']}{detail}{C['reset']}" if detail else ""))


def warn(m: str) -> None:
    print(f"  {C['y']}NOTE{C['reset']}  {m}")


def npm_cmd(*args: str) -> list[str]:
    """Resolve npx for the running platform.

    On Windows `npx` is `npx.cmd`, a shim that only the shell can execute.
    subprocess without shell=True raises FileNotFoundError on it, which is how
    the first version of this harness reported "vitest: not found" while vitest
    was passing perfectly well in the same terminal.
    """
    exe = shutil.which("npx")
    if exe:
        return [exe, *args]
    if os.name == "nt":
        return ["cmd", "/c", "npx", *args]
    return ["npx", *args]


def run(label: str, cmd: list[str], cwd: Path, timeout: int = 600,
        env: dict[str, str] | None = None) -> tuple[bool, str]:
    try:
        p = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                           timeout=timeout, env=env)
    except FileNotFoundError:
        return False, f"{cmd[0]} not found on PATH"
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout}s"
    out = (p.stdout or "") + (p.stderr or "")
    return p.returncode == 0, out


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

def plain(text: str) -> str:
    """Strip ANSI colour codes.

    Not cosmetic. vitest prints `Tests \x1b[22m \x1b[1m263 passed`, so the
    label and the number are separated by escape sequences. A regex written
    against the visible text matches nothing, which is why the first version
    of this harness reported "all suites passed" instead of "263 passed" —
    a number that looked plausible and was never actually read.
    """
    return ANSI.sub("", text)


def tail(text: str, n: int = 6) -> str:
    lines = [ln for ln in text.strip().splitlines() if ln.strip()]
    return "\n        ".join(lines[-n:])


# ---------------------------------------------------------------- checks

def check_extension() -> bool:
    head("1/6  Extension unit tests + TypeScript")
    good, out = run("vitest", npm_cmd("vitest", "run"), EXT)
    body = plain(out)
    if good:
        m = re.search(r"Tests\s+(?:(\d+) failed \|\s*)?(\d+) passed", body)
        if not m:
            bad("vitest passed but printed no test count", tail(body, 8))
            good = False
        else:
            ok(f"vitest: {m.group(2)} passed"
               + (f", {m.group(1)} FAILED" if m.group(1) else ""))
    else:
        bad("vitest", tail(body, 12))

    good2, out2 = run("tsc", npm_cmd("tsc", "--noEmit"), EXT)
    if good2:
        ok("tsc --noEmit: no type errors")
    else:
        bad("tsc --noEmit", tail(plain(out2), 10))
    return good and good2


def check_python(suite: str, label: str) -> bool:
    good, out = run(suite, [PY, f"bench/{suite}.py"], ROOT, timeout=300)
    body = plain(out)
    if good:
        # Every suite ends with an explicit tally, e.g. "12/12 passed" or
        # "all 16 checks passed". Requiring one means a suite that exits 0
        # without reporting a count is surfaced, not silently called a pass.
        m = (re.search(r"(\d+)/(\d+) passed", body)
             or re.search(r"all (\d+) [a-zA-Z/ ]*passed", body))
        if not m:
            bad(f"{label} passed but reported no count", tail(body, 6))
            return False
        ok(f"{label}: {m.group(0)}")
    else:
        bad(label, tail(body, 12))
    return good


def check_server() -> bool:
    head("2/6  Server, providers, CORS, wire contract")
    a = check_python("test_server", "server suite")
    b = check_python("test_providers", "provider/session/privacy")
    c = check_python("test_cors", "CORS (real preflights)")
    d = check_python("test_contract", "wire contract")
    return a and b and c and d


def check_deploy() -> bool:
    head("3/6  Deployment contract")
    return check_python("test_deploy_contract", "container can boot")


def check_live_gate() -> bool:
    head("4/6  Plan gate, driven through the real endpoint")
    return check_python("test_plan_gate_live", "bad plans are escalated live")


def check_build() -> bool:
    head("5/6  Chrome build")
    out_dir = "./out-demo"
    env = {**os.environ, "VEIL_OUT_DIR": out_dir}
    try:
        p = subprocess.run(npm_cmd("wxt", "build"), cwd=str(EXT), env=env,
                           capture_output=True, text=True, timeout=600)
    except Exception as e:  # noqa: BLE001
        bad("wxt build", str(e))
        return False
    body = plain((p.stdout or "") + (p.stderr or ""))
    if p.returncode != 0:
        bad("wxt build", tail(body, 12))
        return False
    m = re.search(r"Total size:\s*([\d.]+\s*kB)", body)
    if not m:
        bad("wxt build succeeded but printed no total size", tail(body, 8))
        return False
    manifest = EXT / out_dir.strip("./") / "chrome-mv3" / "manifest.json"
    if manifest.exists():
        perms = json.loads(manifest.read_text(encoding="utf-8")).get("permissions", [])
        need = {"webNavigation", "tabCapture", "offscreen", "sidePanel"}
        missing = need - set(perms)
        if missing:
            bad(f"manifest missing {sorted(missing)}")
            return False
        ok(f"built {m.group(1)}; manifest has all required permissions")
    else:
        bad("build produced no manifest", f"looked in {manifest}")
        return False
    return True


# ---------------------------------------------------------------- live task

def health() -> dict | None:
    """The running server's own view of itself."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2) as r:
            return json.loads(r.read().decode())
    except Exception:  # noqa: BLE001
        return None


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_port(port: int, timeout: float = 10.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.2)
    return False


def wait_http(url: str, timeout: float = 25.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status < 500:
                    return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.25)
    return False


def load_env() -> dict[str, str]:
    """Read .env WITHOUT printing it. Credentials never reach the console."""
    env: dict[str, str] = {}
    p = ROOT / ".env"
    if not p.exists():
        return env
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip("'\"")
    return env


def config_line(env: dict[str, str]) -> str:
    """Describe the provider config WITHOUT revealing a secret.

    Only presence is ever reported, never a key or URL. `auto` with no
    credentials is a distinct state from a configured provider, and conflating
    them would make the demo claim a live run it cannot perform.
    """
    provider = env.get("VEIL_LLM_PROVIDER", "").strip() or "(unset)"
    has_key = bool(env.get("VEIL_LLM_API_KEY", "").strip())
    has_url = bool(env.get("VEIL_LLM_BASE_URL", "").strip())
    model = env.get("VEIL_LLM_MODEL", "").strip()
    if not has_key and not has_url:
        state = f"{C['y']}no credentials{C['reset']}"
    else:
        state = f"{C['g']}credentials present{C['reset']}"
    bits = [f"provider {provider}", state]
    if model:
        bits.append(f"model {model}")
    return f"  {C['dim']}" + "   ".join(bits) + C["reset"]


def screen_state() -> dict:
    node = lambda i, role="button", vc="plain": {
        "id": f"n{i}", "role": role, "label": f"[BUTTON_{i}]",
        "valueClass": vc, "mark": i, "children": [],
    }
    return {
        "schema_version": "1.0.0", "session_id": "demo-session",
        "title": "Demo form", "url": "http://127.0.0.1:8080/bench/corpus/synthetic/form_00.html",
        "frame_hash": "demohash", "mark_count": 2,
        "root": {"id": "root", "role": "document", "label": "Demo form",
                 "valueClass": "plain", "children": [node(1), node(2)]},
    }


def run_live_task(base: str, offline: bool = False) -> None:
    """Drive one real request through the real HTTP + SSE path.

    `offline` only changes what is CLAIMED. The request, the streaming and the
    parsing are identical either way — what differs is whether a model produced
    the plan. A canned plan printed without that caveat is exactly the kind of
    plausible-looking stand-in this project is supposed to refuse.
    """
    if offline:
        head("6/6  Wire check, through HTTP + SSE  (OFFLINE — not model output)")
    else:
        head("6/6  A real task, through HTTP + SSE")
    payload = {
        "schema_version": "1.0.0", "session_id": "demo-session",
        "intent": "Click the first button on the page.",
        "turn": 0, "screen_state": screen_state(),
        "redaction_manifest": {
            "schema_version": "1.0.0", "session_id": "demo-session",
            "frame_hash": "demohash", "redactions": [], "signature": "0" * 64,
            "model_versions": {}, "abort_reason": None,
        },
    }
    req = urllib.request.Request(
        f"{base}/v1/agent/step", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        bad(f"server returned HTTP {e.code}", e.read().decode()[:300])
        return
    except Exception as e:  # noqa: BLE001
        bad("could not reach the server", str(e))
        return
    ms = (time.perf_counter() - t0) * 1000

    # Reassemble the SSE stream the same way the extension does.
    text = ""
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        p = line[5:].strip()
        if not p or p == "[DONE]":
            continue
        try:
            env = json.loads(p)
        except json.JSONDecodeError:
            continue
        d = env.get("delta") if isinstance(env, dict) else None
        if not isinstance(d, str):
            continue
        if d.lstrip().startswith("{"):
            try:
                json.loads(d)
                text = d
                continue
            except json.JSONDecodeError:
                pass
        text += d

    if not text.strip():
        bad("the server streamed no plan", f"raw response was {raw[:200]!r}")
        return
    try:
        plan = json.loads(text)
    except json.JSONDecodeError as e:
        bad("the plan was not valid JSON", str(e))
        return

    # A plan of "no provider reachable" is the server honestly failing, not a
    # task succeeding. Reporting it as a received plan — which the first
    # version did — is the stand-in this project is supposed to refuse.
    steps = plan.get("steps") or []
    degraded = (not steps) or all(
        s.get("action") in ("none", "ask_user") and "provider" in (s.get("reason") or "").lower()
        for s in steps)
    if degraded:
        print(f"  {C['y']}NOT A PLAN{C['reset']}  the server answered in {ms:.0f} ms with:")
        for s in steps:
            print(f"        {C['dim']}{s.get('action')} — {s.get('reason')}{C['reset']}")
        print(f"        {C['dim']}no model endpoint is reachable, so there is nothing to"
              f" execute.{C['reset']}")
        return

    ok(f"received a plan in {ms:.0f} ms")
    if offline:
        print(f"        {C['y']}produced by the scripted offline provider, not a model."
              f" This proves the wire path only.{C['reset']}")
    print(f"        {C['dim']}confidence {plan.get('confidence')}{C['reset']}")
    for i, s in enumerate(plan.get("steps", [])):
        tgt = (s.get("target") or {}).get("mark")
        print(f"        {C['b']}step {i + 1}{C['reset']}  {s.get('action')}"
              + (f"  -> mark {tgt}" if tgt is not None else "")
              + (f"  {C['dim']}{s.get('reason','')}{C['reset']}" if s.get("reason") else ""))

    print(f"\n  {C['dim']}The extension now executes these steps and reports what it"
          f" observed.\n  Load it, open the panel, and run the same intent to see the"
          f" same plan with real per-step results.{C['reset']}")


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description="Run and verify Veil end to end.")
    ap.add_argument("--verify", action="store_true", help="verification gate only")
    ap.add_argument("--fake", action="store_true",
                    help="use the offline provider (canned plans, not a model)")
    ap.add_argument("--live", action="store_true",
                    help="require a real provider; fail if credentials are missing")
    ap.add_argument("--no-serve", action="store_true",
                    help="do not start the static server (use an already-running one)")
    args = ap.parse_args()

    head("VEIL — privacy-preserving browser vision agent")
    print(f"  {C['dim']}{ROOT}{C['reset']}")

    env = load_env()
    print(config_line(env))

    live_env = {k: v for k, v in env.items()
                if k.startswith("VEIL_") and v.strip()}
    if args.live:
        missing = [k for k in ("VEIL_LLM_BASE_URL", "VEIL_LLM_API_KEY", "VEIL_LLM_MODEL")
                   if not env.get(k, "").strip()]
        if missing:
            head("Cannot run --live")
            for k in missing:
                print(f"  {C['r']}missing{C['reset']}  {k} is empty in .env")
            return 2

    results = [
        check_extension(),
        check_server(),
        check_deploy(),
        check_live_gate(),
        check_build(),
    ]
    head("Verification summary")
    names = ["extension tests + tsc", "server + providers + CORS",
             "deployment contract", "live plan gate", "chrome build"]
    for n, r in zip(names, results):
        print(f"  {C['g'] + 'PASS' if r else C['r'] + 'FAIL'}{C['reset']}  {n}")

    if args.verify:
        print()
        return 0 if all(results) else 1

    if not all(results):
        print(f"\n{C['r']}Not starting the stack: the gate failed.{C['reset']}")
        return 1

    # ---- start the stack -------------------------------------------------
    head("Starting the stack")
    api_env = {**os.environ, **live_env,
               "VEIL_ALLOWED_ORIGINS": env.get("VEIL_ALLOWED_ORIGINS", "dev")}
    if args.fake:
        api_env["VEIL_LLM_PROVIDER"] = "fake"
        print(f"  {C['y']}offline provider{C['reset']} — plans are canned, not from a model")

    procs: list[subprocess.Popen] = []
    want_fake = api_env.get("VEIL_LLM_PROVIDER", "").strip() == "fake"

    running = health()
    if running:
        # A server started earlier — by the user, or by a previous run — may be
        # configured completely differently. The first version of this harness
        # reused whatever was on :8000 and then reported its result, which made
        # a `--fake` run print "no provider reachable" from a server that had
        # never been told to be fake. That is precisely the stale-listener trap:
        # you end up measuring a process you did not start.
        # Real field names, read off /health: `provider` is null when nothing
        # is reachable and `engine` then reads "no provider reachable".
        served_by = running.get("provider") or "(none reachable)"
        engine = running.get("engine") or ""
        bad = []
        if want_fake and served_by != "fake":
            bad.append(f"it is serving {served_by!r}"
                       + (f" ({engine})" if engine else "")
                       + ", not the fake provider")
        if not running.get("provider"):
            bad.append("no provider is reachable on it at all, so it cannot "
                       "produce a plan")
        if bad and args.no_serve:
            warn("using the existing server on :8000 KNOWINGLY (--no-serve):")
            for b in bad:
                print(f"          {C['dim']}{b}{C['reset']}")
            warn("its result below describes THAT server, not this configuration")
        elif bad:
            warn("a server is already on :8000 and it is not the one requested:")
            for b in bad:
                print(f"          {C['dim']}{b}{C['reset']}")
            print(f"          {C['dim']}Stop it, then re-run:{C['reset']}")
            print(f"            {C['c']}netstat -ano | findstr :8000{C['reset']}")
            print(f"            {C['c']}taskkill /PID <pid> /F{C['reset']}")
            if args.live or want_fake:
                print()
                bad_final = "refusing to report a result from a differently-configured server"
                print(f"  {C['r']}{bad_final}{C['reset']}")
                return 3
        else:
            print(f"  API      already running on :8000 ({served_by})")
    else:
        procs.append(subprocess.Popen(
            [PY, "-m", "uvicorn", "server.app:app", "--port", "8000"],
            cwd=str(ROOT), env=api_env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        print("  API      starting on :8000")

    if wait_http("http://127.0.0.1:8000/health"):
        ok("server healthy at http://127.0.0.1:8000/health")
    else:
        bad("server did not become healthy")
        for p in procs:
            p.terminate()
        return 1

    if not args.no_serve:
        if port_open(8080):
            print("  Forms    already running on :8080")
        else:
            procs.append(subprocess.Popen(
                [PY, "-m", "http.server", "8080"],
                cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            print("  Forms    starting on :8080")
        # A fixed sleep is a guess. Poll until the port actually answers, and
        # say so plainly if it never does rather than printing a dead link.
        if not wait_port(8080, timeout=10.0):
            warn("static server did not start; the form link will not work")
        if port_open(8080):
            ok("synthetic form: http://localhost:8080/bench/corpus/synthetic/form_00.html")
        else:
            warn("the form link will not work until a static server is on :8080")

    print(f"\n{C['b']}Load the extension{C['reset']}")
    print(f"  1. chrome://extensions  ->  Developer mode  ->  Load unpacked")
    print(f"  2. choose: {C['c']}{EXT / 'out-demo' / 'chrome-mv3'}{C['reset']}")
    print(f"  3. open {C['c']}http://localhost:8080/bench/corpus/synthetic/form_00.html{C['reset']}")
    print(f"  4. click the Veil icon, then Run a task")

    is_fake = api_env.get("VEIL_LLM_PROVIDER", "").strip() == "fake"
    if is_fake:
        run_live_task("http://127.0.0.1:8000", offline=True)
    elif env.get("VEIL_LLM_API_KEY", "").strip() and env.get("VEIL_LLM_BASE_URL", "").strip():
        run_live_task("http://127.0.0.1:8000", offline=False)
    else:
        head("6/6  A real task, through HTTP + SSE")
        print(f"  {C['y']}NOT MEASURED{C['reset']} — no model endpoint configured.")
        print()
        print(f"  A real task needs a provider. Either:")
        print(f"    {C['c']}--live{C['reset']}   set VEIL_LLM_BASE_URL, VEIL_LLM_API_KEY and")
        print(f"            VEIL_LLM_MODEL in .env (values are never printed)")
        print(f"    {C['c']}--fake{C['reset']}  run the offline provider, which returns a canned plan")
        print(f"            {C['dim']}- useful for wiring checks, NOT evidence the model works{C['reset']}")
        print()
        print(f"  The API is still running, so the panel will connect and show its real")
        print(f"  state. Capture, redaction and the approval gate work without a model.")

    print(f"\n{C['dim']}Ctrl-C to stop the servers started here.{C['reset']}\n")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nstopping…")
    finally:
        for p in procs:
            p.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
