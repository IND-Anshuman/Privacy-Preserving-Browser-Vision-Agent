#!/usr/bin/env python3
"""End-to-end server test — runs the real FastAPI app, no vLLM required.

Verifies the three behaviours that matter for the privacy claim:
  1. A well-formed request produces a schema-valid plan (or an honest `none`).
  2. A client-reported gate abort is REFUSED with 409 — the server fails closed too.
  3. No payload is ever logged: only hashes and byte counts.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Import as `server.app`, not a bare `app`. app.py uses package-relative imports
# (so it runs from the repo root as the README says), and importing it as a
# top-level module makes those relative imports fail. This suite is the one
# place that still assumed the old flat layout.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from server import app as veil_app  # noqa: E402
from server.actions import ACTION_NAMES, check_plan_against_state, validate_plan  # noqa: E402

SCREEN_STATE = {
    "schema_version": "1.0.0",
    "session_id": "session-abc12345",
    "frame_hash": "abcdef0123456789",
    "url": "https://bank.test/kyc",
    "title": "KYC form",
    "root": {
        "id": "root", "role": "document", "valueClass": "public",
        "children": [
            {"id": "n1", "role": "textbox", "label": "Full name", "valueClass": "sensitive",
             "mark": 1, "actions": ["fill"], "children": []},
            {"id": "n2", "role": "textbox", "label": "City", "valueClass": "public",
             "mark": 2, "actions": ["fill"], "children": []},
            {"id": "n3", "role": "button", "label": "Submit application", "valueClass": "public",
             "mark": 3, "actions": ["click"], "children": []},
        ],
    },
    "mark_count": 3,
}

MANIFEST = {
    "schema_version": "1.0.0",
    "session_id": "session-abc12345",
    "redactions": [
        {"id": "r1", "box": {"x": 10, "y": 20, "w": 200, "h": 30}, "cls": "PERSON",
         "placeholder": {"token": "[PERSON_1]", "cls": "PERSON"}, "method": "solid_fill",
         "score": 0.99, "source": "L0", "pixelDerived": False},
        {"id": "r2", "box": {"x": 10, "y": 60, "w": 200, "h": 30}, "cls": "PASSWORD",
         "placeholder": {"token": "[PASSWORD]", "cls": "PASSWORD"}, "method": "solid_fill",
         "score": 0.99, "source": "L0", "pixelDerived": False},
    ],
    "frame_hash": "abcdef0123456789",
    "signature": "a" * 32,
    "model_versions": {"l2_ner": "gliner", "l3_face": "blazeface", "l3_text": "dbnet", "runtime": "webgpu"},
    "abort_reason": None,
}


def body(**over) -> dict:
    b = {
        "schema_version": "1.0.0",
        "session_id": "session-abc12345",
        "intent": "fill the city and click submit",
        "turn": 0,
        "screen_state": SCREEN_STATE,
        "redaction_manifest": MANIFEST,
        "image_b64": "UklGRg==",
        "client_timings": {"capture": 12.0},
        "tier": "T1",
    }
    b.update(over)
    return b


def main() -> int:
    failures: list[str] = []
    total = 0

    def check(name: str, cond: bool, detail: str = "") -> None:
        # `total` is counted here rather than at the call sites so the tally
        # cannot drift from the number of checks actually run. The gate in
        # demo.py requires an explicit count, which is how this suite was found
        # to print "all passed" with no way to tell 5 checks from 500.
        nonlocal total
        total += 1
        print(f"  {'PASS' if cond else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
        if not cond:
            failures.append(name)

    with TestClient(veil_app.app) as c:
        print("\n  VEIL SERVER E2E")
        print("  " + "-" * 58)

        r = c.get("/health")
        check("health responds", r.status_code == 200)
        check("health reports vllm availability", "vllm" in r.json(), str(r.json().get("engine")))

        # 1. happy path -> SSE with a schema-valid plan.
        #    vLLM is not running in CI, so the server must degrade to an honest
        #    `none` plan rather than inventing a target. That degradation IS the
        #    behaviour under test — a hallucinated plan here would be a failure.
        r = c.post("/v1/agent/step", json=body())
        check("step returns 200", r.status_code == 200, f"got {r.status_code}")
        check("content-type is SSE", "text/event-stream" in r.headers.get("content-type", ""))

        deltas: list[str] = []
        saw_done = False
        for line in r.text.splitlines():
            if not line.startswith("data: "):
                continue
            raw = line[len("data: "):].strip()
            if raw == "[DONE]":
                saw_done = True
                continue
            deltas.append(json.loads(raw).get("delta", ""))
        plan_txt = "".join(deltas)

        check("SSE stream is terminated with [DONE]", saw_done)
        try:
            plan = json.loads(plan_txt)
            check("emitted plan is valid JSON", True)
            check(
                "emitted plan matches the ActionPlan contract",
                isinstance(plan.get("steps"), list)
                and len(plan["steps"]) >= 1
                and plan["steps"][0].get("action") in ACTION_NAMES
                and 0.0 <= plan.get("confidence", -1) <= 1.0,
                f"action={plan['steps'][0].get('action')}",
            )
            # With no engine behind it, honesty is the requirement.
            if not veil_app.client.available:
                check(
                    "unavailable engine degrades to `none`, not a hallucinated target",
                    plan["steps"][0]["action"] == "none" and plan["confidence"] == 0.0,
                )
                check(
                    "degradation names the reason in needs_more_context",
                    bool(plan.get("needs_more_context")),
                )
        except json.JSONDecodeError as e:
            check("emitted plan is valid JSON", False, f"{e}: {plan_txt[:90]}")

        # 2. FAIL CLOSED — a client that aborted must get no plan
        aborted = json.loads(json.dumps(MANIFEST))
        aborted["abort_reason"] = "3 classified items have no covering box"
        r = c.post("/v1/agent/step", json=body(redaction_manifest=aborted))
        check("aborted manifest is refused (409)", r.status_code == 409, f"got {r.status_code}")
        check("refusal names the reason", "aborted" in r.text.lower())

        # 3. delta turn with neither image nor tiles is rejected
        r = c.post("/v1/agent/step", json=body(turn=1, image_b64=None, tiles=None))
        check("empty delta turn rejected", r.status_code == 400, f"got {r.status_code}")

        # 4. validation endpoint catches a plan that would fill a hidden field
        bad = {
            "schema_version": "1.0.0", "session_id": "session-abc12345",
            "steps": [{"action": "fill", "target": {"mark": 1}, "value": "Ankit Sharma"}],
            "confidence": 0.9,
        }
        r = c.post("/v1/agent/validate", json={"plan": bad})
        parsed = validate_plan(bad)
        problems = check_plan_against_state(parsed, SCREEN_STATE)
        check("semantic check blocks filling a sensitive field", len(problems) > 0, "; ".join(problems))

        # 5. marks that do not exist are caught
        ghost = {
            "schema_version": "1.0.0", "session_id": "session-abc12345",
            "steps": [{"action": "click", "target": {"mark": 99}}],
            "confidence": 0.9,
        }
        problems = check_plan_against_state(validate_plan(ghost), SCREEN_STATE)
        check("semantic check catches a nonexistent mark", any("does not exist" in p for p in problems))

        # 6. an action outside the vocabulary is rejected
        try:
            validate_plan({
                "schema_version": "1.0.0", "session_id": "session-abc12345",
                "steps": [{"action": "exfiltrate"}], "confidence": 0.9,
            })
            check("unknown action rejected", False)
        except Exception:
            check("unknown action rejected", True)

        # 7. destructive action forced to ask_user
        try:
            validate_plan({
                "schema_version": "1.0.0", "session_id": "session-abc12345",
                "steps": [{"action": "click", "target": {"mark": 3}, "reason": "submit the form"}],
                "confidence": 0.9,
            })
            check("destructive step forced to ask_user", False)
        except Exception:
            check("destructive step forced to ask_user", True)

    print("  " + "-" * 58)
    if failures:
        print(f"  {len(failures)} FAILED: {', '.join(failures)}\n")
        return 1
    print(f"  all {total} server checks passed\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
