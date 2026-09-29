"""
One real task, through the real HTTP + SSE path, against the live provider.

This is the check that the SSE fix was for. Before it, the extension did
`JSON.parse(await res.text())` on a `text/event-stream` body, so every plan the
server produced failed to parse and no task could ever run. The 8/8 grounding
run could not catch that, because it measures the SERVER's output, not the
CLIENT's ability to read it.

This measures the client's parse against a live stream, and prints the plan it
recovered so the steps can be inspected rather than trusted.

    ./.venv/Scripts/python.exe bench/live_task.py --port 8022
    ./.venv/Scripts/python.exe bench/live_task.py --port 8022 --intent "click submit"
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
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
        print(f"  FAIL  {name}" + (f"\n          {detail}" if detail else ""))


def screen_state() -> dict:
    """A schema-valid screen, matching what the extension really sends."""
    def node(i: int, role: str, label: str) -> dict:
        return {
            "id": f"n{i}", "role": role, "label": label,
            "valueClass": "plain", "mark": i, "children": [],
        }

    return {
        "schema_version": "1.0.0",
        "session_id": "live-task-0001",
        "title": "Checkout form",
        "url": "http://127.0.0.1:8080/bench/corpus/synthetic/form_00.html",
        "frame_hash": "livehash0001",
        "mark_count": 3,
        "root": {
            "id": "root", "role": "document", "label": "Checkout form",
            "valueClass": "plain",
            "children": [
                node(1, "textbox", "[BUTTON_1] City"),
                node(2, "textbox", "[BUTTON_2] Postal code"),
                node(3, "button", "[BUTTON_3] Submit order"),
            ],
        },
    }


def body(intent: str, session: str = "live-task-0001") -> dict:
    # The session id is a PARAMETER, not a constant.
    #
    # Reusing one id across requests silently exhausted the server's replan cap
    # (`sess.exhausted()` -> action:none-ish `ask_user`, "manual intervention
    # required"). The first version of the destructive test passed four
    # intents through ONE session, so requests 2-4 never reached the model at
    # all — they returned in 2-15ms instead of ~10s. The gate results looked
    # correct and were entirely an artifact of the test.
    return {
        "schema_version": "1.0.0",
        "session_id": session,
        "intent": intent,
        "turn": 0,
        "tier": "T1",
        "screen_state": screen_state(),
        "redaction_manifest": {
            "schema_version": "1.0.0",
            "session_id": "live-task-0001",
            "frame_hash": "livehash0001",
            # Field names are NOT guesses. RedactionModel in server/app.py
            # requires exactly: id, box, cls, placeholder, method, score,
            # source, pixelDerived. An earlier version of this fixture used
            # invented names (kind/value_class/coverage) and got a 422 — which
            # is the contract working, not the contract being wrong.
            "redactions": [
                {
                    "id": "r1",
                    "box": {"x": 0.10, "y": 0.20, "w": 0.30, "h": 0.05},
                    "cls": "name",
                    "placeholder": {"type": "person", "value": "<redacted:person>"},
                    "method": "l2",
                    "score": 0.95,
                    "source": "dom",
                    "pixelDerived": False,
                },
            ],
            "signature": "0" * 64,
            "model_versions": {},
            "abort_reason": None,
        },
        # A 1x1 PNG. The point of this check is the WIRE, not the pixels.
        "image_b64": (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM"
            "IQAAAABJRU5ErkJggg=="
        ),
    }


def fetch_plan(base: str, intent: str, session: str = "live-task-0001") -> tuple[str, dict | None, float, str]:
    """Reassemble the SSE stream exactly as extension/lib/sse.ts does."""
    payload = json.dumps(body(intent, session)).encode()
    req = urllib.request.Request(
        f"{base}/v1/agent/step", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        return "", None, (time.perf_counter() - t0) * 1000, f"HTTP {e.code}: {e.read().decode()[:300]}"
    ms = (time.perf_counter() - t0) * 1000

    text = ""
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if not chunk or chunk == "[DONE]":
            continue
        try:
            env = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        d = env.get("delta") if isinstance(env, dict) else None
        if not isinstance(d, str):
            continue
        # A whole-JSON delta REPLACES the buffer: the escalation gate re-streams
        # a replaced plan in one piece after the model's fragments.
        if d.lstrip().startswith("{"):
            try:
                json.loads(d)
                text = d
                continue
            except json.JSONDecodeError:
                pass
        text += d

    try:
        return text, json.loads(text), ms, ""
    except json.JSONDecodeError as e:
        return text, None, ms, f"{e}; got {text[:200]!r}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8022)
    ap.add_argument("--intent", default="Fill the city, then fill the postal code.")
    a = ap.parse_args()
    base = f"http://127.0.0.1:{a.port}"

    print("\n  LIVE TASK — one real request through HTTP + SSE")
    print("  " + "-" * 66)

    # The provider must actually be selected, or this measures nothing.
    try:
        health = json.loads(
            urllib.request.urlopen(f"{base}/health", timeout=30).read().decode()
        )
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL  server not reachable on {base}: {e}")
        return 1
    check("a provider is selected", health.get("provider") is not None,
          f"engine={health.get('engine')!r}")
    print(f"        provider={health.get('provider')}  model={health.get('model')}")

    text, plan, ms, err = fetch_plan(base, a.intent)
    check("the SSE stream yielded a parseable plan", plan is not None, err)
    if plan is None:
        print(f"\n  {PASS}/{PASS + FAIL} passed\n")
        return 1

    print(f"        {len(text)} chars in {ms:.0f} ms")
    steps = plan.get("steps") or []
    for i, s in enumerate(steps):
        tgt = (s.get("target") or {}).get("mark")
        print(f"        step {i + 1}: {s.get('action')}"
              + (f" -> mark {tgt}" if tgt is not None else "")
              + (f"  [{s.get('reason', '')}]" if s.get("reason") else ""))

    # The three claims that matter, and that the old JSON.parse path broke.
    check("the plan parses as an ActionPlan", isinstance(steps, list) and bool(steps))
    check("every step names an action", all(s.get("action") for s in steps))
    # Only steps that actually NAME a mark can invent one. An `ask_user` step
    # replaced by the destructive gate has no target at all, and scoring its
    # missing mark as "invented" would report the safety interlock working as
    # a grounding failure.
    named = [(s.get("target") or {}).get("mark") for s in steps
             if (s.get("target") or {}).get("mark") is not None]
    check("the model invented no marks",
          all(m <= 3 for m in named),
          f"marks={named} (steps naming a mark: {len(named)}/{len(steps)})")
    check("confidence is present and is a number",
          isinstance(plan.get("confidence"), (int, float)),
          f"confidence={plan.get('confidence')!r}")

    # A degraded plan must never be reported as a task.
    degraded = all(
        s.get("action") in ("none", "ask_user")
        and "provider" in (s.get("reason") or "").lower()
        for s in steps
    ) if steps else True
    check("this is a real plan, not a 'no provider reachable' stub", not degraded,
          f"steps={[(s.get('action'), s.get('reason')) for s in steps]}")

    # Report the outcome so the extension's accounting can be checked.
    try:
        out = json.dumps({
            "session_id": "live-task-0001",
            "steps": [{"action": s.get("action"),
                       "ok": True, "effect": "changed",
                       "reason": s.get("reason")} for s in steps],
        }).encode()
        oreq = urllib.request.Request(
            f"{base}/v1/agent/outcome", data=out,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(oreq, timeout=30) as r:
            accepted = r.status == 200
        check("the server accepted the outcome report", accepted)
    except Exception as e:  # noqa: BLE001
        check("the server accepted the outcome report", False, str(e))

    print("\n  " + "-" * 66)
    print(f"  {PASS}/{PASS + FAIL} passed\n")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
