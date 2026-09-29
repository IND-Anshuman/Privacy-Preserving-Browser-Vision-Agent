"""
The destructive gate must read the TARGET'S OWN LABEL, not just the plan's words.

THE DEFECT THIS WAS FOUND BY
----------------------------
Driving the live model with "pay for the order" returned:

    actions=['wait_for', 'click']   confidence=0.98   needs_more_context=[]

An unattended click on a pay button. The gate did not fire.

WHY
---
`ActionPlan._shape` builds a `blob` from the step's own fields — action, value,
text, reason, url, `target.name`, `target.selector` — and greps it for a
destructive verb. But a grounded plan addresses a control by MARK, and the words
that make it dangerous live in the SCREEN NODE's label, which the plan never
repeats. `click` + `mark: 3` against a node labelled "Submit order" contains no
destructive token anywhere in the blob, so it passed with confidence 0.98.

The screen state is already available in `check_plan_against_state`, and
`collect_marks` already walks it. The label is one lookup away.

WHAT THIS DOES NOT DO
---------------------
It does not try to classify buttons by colour, position or shape. It resolves
the label the client already sent and applies the same keyword rule that
already governs `action` and `reason`. No new heuristic, one more field in the
same scan.

    ./.venv/Scripts/python.exe bench/test_destructive_label.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.actions import ActionPlan, check_plan_against_state  # noqa: E402

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


def node(mark: int, label: str, role: str = "button", value_class: str = "plain") -> dict:
    return {"id": f"n{mark}", "role": role, "label": label,
            "valueClass": value_class, "mark": mark, "children": []}


SCREEN = {
    "schema_version": "1.0.0", "session_id": "live-destr-0000",
    "title": "Checkout", "url": "http://127.0.0.1:8080/form",
    "frame_hash": "h", "mark_count": 5,
    "root": {"id": "root", "role": "document", "label": "Checkout",
             "valueClass": "plain", "children": [
                 node(1, "[BUTTON_1] City", "textbox"),
                 node(2, "[BUTTON_2] Postal code", "textbox"),
                 node(3, "[BUTTON_3] Submit order"),
                 node(4, "[BUTTON_4] Pay now"),
                 node(5, "[BUTTON_5] Cancel"),
             ]},
}


def plan(*steps: dict) -> ActionPlan:
    return ActionPlan.model_validate({
        "schema_version": "1.0.0", "session_id": "live-destr-0000",
        "steps": list(steps), "confidence": 0.98, "needs_more_context": [],
    })


def main() -> int:
    print("\n  DESTRUCTIVE GATE — the target's own label must be scanned")
    print("  " + "-" * 70)

    # 1. The regression: a grounded click on a Submit button.
    p = plan({"action": "click", "target": {"mark": 3}}, {"action": "none"})
    problems = check_plan_against_state(p, SCREEN)
    check("a click on a node labelled 'Submit order' is flagged",
          any("destructive" in x.lower() for x in problems),
          f"problems={problems} — the plan says only 'click' + 'mark 3', so the "
          f"verb lives purely in the screen node's label")

    p2 = plan({"action": "click", "target": {"mark": 4}}, {"action": "none"})
    problems2 = check_plan_against_state(p2, SCREEN)
    check("a click on a node labelled 'Pay now' is flagged",
          any("destructive" in x.lower() for x in problems2),
          f"problems={problems2}")

    # 2. A benign control must NOT be escalated, or the gate is noise.
    p3 = plan({"action": "click", "target": {"mark": 5}}, {"action": "none"})
    problems3 = check_plan_against_state(p3, SCREEN)
    check("a click on 'Cancel' is NOT flagged",
          not any("destructive" in x.lower() for x in problems3),
          f"problems={problems3}")

    p4 = plan({"action": "fill", "target": {"mark": 1}, "value": "Pune"},
              {"action": "none"})
    problems4 = check_plan_against_state(p4, SCREEN)
    check("filling a City field is NOT flagged",
          not any("destructive" in x.lower() for x in problems4),
          f"problems={problems4}")

    # 3. A destructive verb in the plan's own words still fires (no regression).
    #    ActionPlan raises at CONSTRUCTION time, so the raise IS the assertion.
    try:
        ActionPlan.model_validate({
            "schema_version": "1.0.0", "session_id": "live-destr-0000",
            "steps": [{"action": "click", "target": {"mark": 5},
                       "reason": "click submit to place the order"},
                      {"action": "none"}],
            "confidence": 0.98, "needs_more_context": [],
        })
        fired = False
    except Exception as e:  # noqa: BLE001
        fired = "destructive" in str(e).lower()
    check("a destructive word in the reason is still rejected at parse time", fired)

    # 4. The mark must actually exist, or we cannot resolve a label.
    p6 = plan({"action": "click", "target": {"mark": 99}}, {"action": "none"})
    problems6 = check_plan_against_state(p6, SCREEN)
    check("a nonexistent mark is still reported",
          any("does not exist" in x for x in problems6), f"problems={problems6}")

    # 5. A label that only LOOKS destructive must not trip it.
    SCREEN_SAFE = {
        **SCREEN,
        "root": {**SCREEN["root"], "children": [
            node(6, "[BUTTON_6] Submit feedback draft"),
            node(7, "[BUTTON_7] Send later"),
        ]},
    }
    p7 = plan({"action": "click", "target": {"mark": 6}}, {"action": "none"})
    check("'Submit feedback draft' is escalated (submit is destructive)",
          any("destructive" in x.lower() for x in check_plan_against_state(p7, SCREEN_SAFE)))
    p8 = plan({"action": "click", "target": {"mark": 7}}, {"action": "none"})
    check("'Send later' is NOT escalated (send needs an object)",
          not any("destructive" in x.lower() for x in check_plan_against_state(p8, SCREEN_SAFE)),
          f"problems={check_plan_against_state(p8, SCREEN_SAFE)}")

    # 5. THE FAIL-OPEN. A plan rejected for a destructive verb must NOT be
    #    treated as "unparseable, carry on".
    #
    #    `_apply_escalation_gate` did:
    #        try: plan = ActionPlan.model_validate_json(raw)
    #        except Exception: return None      # <- None means "let it through"
    #
    #    A ValidationError raised BY THE SAFETY CHECK therefore read exactly
    #    like a truncated JSON blob, and the one case that most needs a human
    #    was the one case allowed through. Measured: "pay for the order"
    #    returned action=click, confidence=0.98, straight to the client.
    #
    #    The distinction is recoverable: a safety rejection has a MESSAGE, a
    #    truncation does not.
    import server.app as app_mod  # noqa: E402
    rejected = json.dumps({
        "schema_version": "1.0.0", "session_id": "live-destr-0000",
        "steps": [{"action": "click", "target": {"mark": 5},
                   "reason": "click submit to place the order"},
                  {"action": "none"}],
        "confidence": 0.98, "needs_more_context": [],
    })

    class _Sess:
        def exhausted(self): return False
        attempts = [1]

    class _Req:
        screen_state = SCREEN
        session_id = "live-destr-0000"

    gated = app_mod._apply_escalation_gate(rejected, _Req(), _Sess())
    check("a safety rejection is NOT passed through as an executable plan",
          gated is not None, "returned None, which _apply_escalation_gate's caller "
          "reads as 'no replacement needed' — the unsafe plan ships verbatim")
    if gated is not None:
        try:
            g = json.loads(gated)
            acts = [x.get("action") for x in g.get("steps", [])]
            check("the replacement asks the human instead of clicking",
                  "ask_user" in acts, f"actions={acts}")
        except Exception:  # noqa: BLE001
            check("the replacement is valid JSON", False, gated[:120])

    print("\n  " + "-" * 70)
    print(f"  {PASS}/{PASS + FAIL} passed\n")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
