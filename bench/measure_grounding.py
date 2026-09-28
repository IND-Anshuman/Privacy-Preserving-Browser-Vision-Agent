"""Does your chosen model actually ground on Veil's [MARK] numbers?

THIS IS THE PROJECT'S BIGGEST UNVERIFIED ASSUMPTION, and this script is how you
check it before trusting a plan.

Frontier vision models are trained to DESCRIBE pages, not to INDEX elements.
An API model may look far more capable than a small local VLM and still be bad
at "click the element numbered 7" — which is the only thing Veil asks it to do.
The difference is invisible in a demo and fatal in a form.

So: point this at your endpoint, and it will report whether marks are used,
whether invented ones appear, and whether the plan is schema-valid.

    # one-off, from the repo root
    ./.venv/Scripts/python.exe bench/measure_grounding.py

    # or against a real corpus turn
    ./.venv/Scripts/python.exe bench/measure_grounding.py --turns 8

Needs: VEIL_LLM_API_KEY, VEIL_LLM_BASE_URL, VEIL_LLM_MODEL.
Without them it says so and exits non-zero rather than reporting a fake 0%.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.prompts import build_system_preamble  # noqa: E402
from server.providers import OpenAICompatProvider, PlanRequest  # noqa: E402
from server.vllm_client import ActionPlan  # noqa: E402

CORPUS = ROOT / "bench" / "corpus" / "synthetic"


def _nodes_from_form(form: dict) -> list[dict]:
    """Reconstruct a screen_state-shaped tree from a corpus form.

    The corpus JSON is DETECTION ground truth — it has `html`, `instances` and
    `field_ids`, but no `root` node. The probe needs a pruned tree with marks,
    so it derives one from the HTML. Reading `form["root"]` (which is what the
    first version did) silently produced an empty tree, which is why every
    target came back as an invented mark.

    A real screen_state comes from the extension at runtime. Deriving one here
    keeps the probe self-contained; the mark numbering is this probe's own, and
    the probe checks the model against the SAME numbering it sent, which is the
    property that actually matters.
    """
    from html.parser import HTMLParser

    # The corpus stores the filename in `html` (e.g. "form_00.html"). The first
    # version looked for `html_file`, found nothing, and every form was skipped
    # with "no interactive nodes" — a wrong answer that reads like a real one.
    html_ref = form.get("html") or form.get("html_file") or ""
    html = ""
    if html_ref and Path(html_ref).suffix == ".html":
        p = CORPUS / html_ref
        html = p.read_text(encoding="utf-8") if p.exists() else ""
    if not html:
        p = CORPUS / f"{form.get('id', '')}.html"
        if p.exists():
            html = p.read_text(encoding="utf-8")
    if not html:
        return []

    class P(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.out: list[dict] = []
            self.n = 0

        def handle_starttag(self, tag, attrs) -> None:
            if tag not in ("input", "button", "select", "textarea", "a"):
                return
            a = dict(attrs)
            label = (
                a.get("aria-label")
                or a.get("placeholder")
                or a.get("name")
                or a.get("id")
                or tag
            )
            self.n += 1
            self.out.append(
                {
                    "mark": self.n,
                    "role": tag,
                    "label": str(label)[:70],
                    "actions": ["fill"] if tag in ("input", "textarea") else ["click"],
                    "valueClass": "sensitive" if a.get("type") == "password" else "public",
                }
            )

    p = P()
    try:
        p.feed(html)
    except Exception:  # noqa: BLE001
        return []
    return p.out


def _make_request(form: dict, intent: str) -> tuple[PlanRequest, set[int]]:
    """Build a PlanRequest from a corpus form, matching what the client sends."""
    nodes = _nodes_from_form(form)
    marks = [n["mark"] for n in nodes]
    valid = set(marks)
    lines = []
    for n in nodes:
        hidden = " (hidden)" if n["valueClass"] == "sensitive" else ""
        actions = f" <{','.join(n['actions'])}>" if n.get("actions") else ""
        lines.append(f'[{n["mark"]}] {n["role"]} "{n["label"]}"{hidden}{actions}')

    manifest = {
        "session_id": f"bench-{form.get('id', 'session')}",
        "frame_hash": form.get("sha256", "0" * 32),
        "model_versions": {},
        "redactions": [
            {
                "cls": i["cls"],
                "placeholder": {"token": f"[{i['cls']}_A3_1a2b3c4d]"},
                "pixel_derived": i.get("channel") == "pixels",
            }
            for i in form.get("instances", [])
        ],
    }
    user = "\n".join(
        [
            f"PAGE: {form.get('title', 'bench form')}",
            f"URL: https://example.invalid/{form.get('id', '')}",
            f"MARKS: {len(marks)}",
            "",
            *lines,
            "",
            f"USER WANTS: {intent}",
        ]
    )
    return (
        PlanRequest(
            system=build_system_preamble(manifest),
            user_text=user,
            image_b64=None,  # structure-only probe; the image path is exercised live
            session_id=manifest["session_id"],
            turn=0,
        ),
        valid,
    )


def score(plan_text: str, valid_marks: set[int]) -> dict:
    """What matters about a plan, beyond whether it parses.

    Handles both shapes a step can arrive in. `ActionPlan.steps` is typed
    `list[ActionStep]`, but a plan built by hand or from a raw dict has plain
    dicts, and assuming one or the other has already bitten this codebase once
    (`plan.steps[0].get(...)` raised AttributeError on the first usable plan).
    """
    out = {
        "parses": False,
        "uses_mark": False,
        "invented_marks": [],
        "action": None,
        "confidence": None,
    }
    try:
        plan = ActionPlan.model_validate_json(plan_text)
    except Exception:  # noqa: BLE001
        return out
    out["parses"] = True

    def _get(step, key, default=None):
        if isinstance(step, dict):
            return step.get(key, default)
        return getattr(step, key, default)

    steps = plan.steps
    out["action"] = _get(steps[0], "action") if steps else None
    out["confidence"] = plan.confidence
    used: list[int] = []
    for s in steps:
        t = _get(s, "target")
        if t is None:
            continue
        m = t.get("mark") if isinstance(t, dict) else getattr(t, "mark", None)
        if m is not None:
            used.append(int(m))
    out["uses_mark"] = bool(used)
    out["invented_marks"] = sorted({m for m in used if m not in valid_marks})
    return out


async def run(turns: int) -> int:
    for k in ("VEIL_LLM_API_KEY", "VEIL_LLM_BASE_URL", "VEIL_LLM_MODEL"):
        if not os.environ.get(k):
            print(f"\n  {k} is not set. This probe needs a real endpoint — it is")
            print("  measuring your model, and there is no honest default for that.\n")
            return 2

    p = OpenAICompatProvider()
    if not await p.probe():
        print(f"\n  endpoint not usable: {p.engine_summary}\n")
        return 2

    forms = sorted(CORPUS.glob("form_*.json"))[:turns] if CORPUS.exists() else []
    if not forms:
        print("\n  no corpus found. Run: python bench/gen_synthetic.py\n")
        return 2

    print("=" * 74)
    print(f"  GROUNDING PROBE — {p.model} via {p.caps.name} "
          f"(schema={p.caps.schema_enforcement}, zdr={p.caps.zdr_eligible})")
    print("=" * 74)

    rows: list[dict] = []
    for path in forms:
        form = json.loads(path.read_text(encoding="utf-8"))
        req, valid = _make_request(form, "fill the form and stop before submitting")
        if not valid:
            print(f"  {path.stem}: no interactive nodes derived from the HTML — skipped")
            continue
        t0 = time.perf_counter()
        try:
            res = await p.complete(req)
        except Exception as e:  # noqa: BLE001
            print(f"  {path.stem}: request failed — {type(e).__name__}: {e}")
            continue
        ms = (time.perf_counter() - t0) * 1000
        s = score(res.text, valid)
        s["form"] = path.stem
        s["ms"] = round(ms)
        s["in_tok"] = res.input_tokens
        s["out_tok"] = res.output_tokens
        s["usd"] = res.usd(p.caps)
        rows.append(s)
        flag = "INV" if s["invented_marks"] else "   "
        print(
            f"  {path.stem:10} parse={'Y' if s['parses'] else 'N'} "
            f"action={(s['action'] or '-'):9} mark={'Y' if s['uses_mark'] else 'N'} "
            f"conf={s['confidence']} {flag} {s['ms']:>5}ms "
            f"{res.input_tokens:>5}in {s['usd'] if s['usd'] is None else round(s['usd'], 6)}usd"
        )

    if not rows:
        print("\n  no results\n")
        return 2

    n = len(rows)
    parsed = sum(1 for r in rows if r["parses"])
    used = sum(1 for r in rows if r["uses_mark"])
    invented = sum(1 for r in rows if r["invented_marks"])
    lat = sorted(r["ms"] for r in rows)
    total_usd = sum(r["usd"] or 0.0 for r in rows)
    known_usd = all(r["usd"] is not None for r in rows)

    print("-" * 74)
    print(f"  forms                 : {n}")
    print(f"  schema-valid plans    : {parsed}/{n}  ({100*parsed/n:.0f}%)")
    print(f"  used a [MARK]         : {used}/{n}  ({100*used/n:.0f}%)")
    print(f"  INVENTED a mark       : {invented}/{n}  ({100*invented/n:.0f}%)  <- must be 0")
    print(f"  latency p50 / max     : {lat[n//2]} ms / {lat[-1]} ms")
    print(f"  input tokens (mean)   : {sum(r['in_tok'] for r in rows)//n}")
    if known_usd:
        print(f"  cost for {n} turns    : ${total_usd:.6f}  "
              f"(${total_usd/n:.6f}/turn)")
    else:
        print("  cost                  : UNKNOWN (set VEIL_LLM_PRICING_IN/OUT)")
    print("-" * 74)

    verdict = []
    if parsed < n:
        verdict.append("SCHEMA FAILURE — plans are being rejected. Set VEIL_LLM_MODE=strict, "
                       "or accept that the validator is your only gate.")
    if used == 0 and n:
        verdict.append("NO MARK USE — this model describes pages but does not target elements "
                       "by number. Do not ship it as the planner.")
    if invented:
        verdict.append(f"INVENTED MARKS in {invented}/{n} turns. A mark that does not exist is a "
                       "click on the wrong thing; the client rejects these, but treat it as a "
                       "grounding failure, not a client bug.")
    if not verdict:
        verdict.append("Grounding looks usable. Still verify on the real task suite (M1) "
                       "before trusting it.")

    print("VERDICT")
    for v in verdict:
        print(f"  · {v}")
    print()

    out = ROOT / "bench" / "results" / "grounding.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "model": p.model,
                "provider": p.caps.name,
                "schema_enforcement": p.caps.schema_enforcement,
                "forms": n,
                "parsed": parsed,
                "used_mark": used,
                "invented_marks": invented,
                "latency_p50_ms": lat[n // 2],
                "latency_max_ms": lat[-1],
                "mean_input_tokens": sum(r["in_tok"] for r in rows) // n,
                "cost_per_turn_usd": (total_usd / n) if known_usd else None,
                "rows": rows,
                "verdict": verdict,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"  wrote bench/results/grounding.json\n")
    return 0


def _all_marks(n: dict) -> set[int]:
    out: set[int] = set()
    if n.get("mark") is not None:
        out.add(int(n["mark"]))
    for c in n.get("children", []):
        out |= _all_marks(c)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--turns", type=int, default=6)
    args = ap.parse_args()
    return asyncio.run(run(args.turns))


if __name__ == "__main__":
    raise SystemExit(main())
