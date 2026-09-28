"""Compare vision models as Veil planners. Measured, not assumed.

    ./.venv/Scripts/python.exe bench/compare_models.py --turns 6 \\
        Qwen/Qwen3-VL-8B-Instruct Qwen/Qwen3-VL-235B-A22B-Thinking

The question this answers is not "which model is best". It is narrower and
more useful: **which model, on YOUR pages, returns a plan Veil can actually
execute.** A model can be the strongest VLM available and still be the wrong
planner, and only a probe against real Veil prompts will say which.

Four things decide that, and all four are measured:

  1. GROUNDING — does it target an element by [MARK] number, or only describe
     the page? This is the project's biggest unverified assumption. An invented
     mark is a click on the wrong thing.
  2. SCHEMA — does the plan parse as an ActionPlan? Truncation and genuine
     schema failure are reported separately, because they send you to
     different places.
  3. LATENCY — p50 and p95, because a 9-second turn is a demo killer and a
     2-second one is not.
  4. COST — per turn, from the declared pricing. Unset pricing is reported as
     UNKNOWN, never as free.

Writes bench/results/model_comparison.json and prints a ranked table.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bench.measure_grounding import _make_request, score  # noqa: E402
from server.prompts import build_system_preamble  # noqa: E402
from server.providers import OpenAICompatProvider, PlanRequest  # noqa: E402
from server.vllm_client import ActionPlan  # noqa: E402

CORPUS = ROOT / "bench" / "corpus" / "synthetic"


def plans_for(n: int) -> list[tuple[str, PlanRequest, set[int]]]:
    out = []
    for path in sorted(CORPUS.glob("form_*.json"))[:n]:
        form = json.loads(path.read_text(encoding="utf-8"))
        req, valid = _make_request(form, "fill the form and stop before submitting")
        if valid:
            out.append((path.stem, req, valid))
    return out


async def run_model(model: str, cases, timeout: float) -> dict:
    """One model's score. Never raises — a model that cannot be reached is a
    result, not a crash, because "this one is unavailable here" is useful."""
    prov = OpenAICompatProvider()
    prov.model = model
    # Re-read pricing from the environment so the cost column is real.
    # PlanCapabilities is a frozen dataclass BY DESIGN — a capability that can
    # be mutated after a provider announces it is not a capability. So build a
    # new one rather than writing to the existing instance.
    def _price(key: str) -> float | None:
        raw = os.environ.get(key, "").strip()
        if not raw:
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    from dataclasses import replace

    prov.caps = replace(
        prov.caps,
        usd_per_mtok_in=_price("VEIL_LLM_PRICING_IN"),
        usd_per_mtok_out=_price("VEIL_LLM_PRICING_OUT"),
    )
    prov.available = None

    row: dict = {
        "model": model,
        "turns": 0,
        "parsed": 0,
        "used_mark": 0,
        "invented": 0,
        "truncated": 0,
        "invalid": 0,
        "latencies": [],
        "in_tok": [],
        "out_tok": [],
        "cost_usd": 0.0,
        "cost_known": True,
        "error": None,
        "as_ms": None,
    }

    if not await prov.probe():
        row["error"] = prov.engine_summary
        row["cost_known"] = False
        return row

    for name, req, valid in cases:
        t0 = time.perf_counter()
        try:
            res = await prov.complete(req)
        except Exception as e:  # noqa: BLE001
            row["error"] = f"{type(e).__name__}: {e}"
            continue
        ms = (time.perf_counter() - t0) * 1000
        s = score(res.text, valid)
        trunc = res.output_tokens >= req.max_tokens - 2

        row["turns"] += 1
        row["parsed"] += 1 if s["parses"] else 0
        row["used_mark"] += 1 if s["uses_mark"] else 0
        row["invented"] += len(s["invented_marks"])
        row["truncated"] += 1 if trunc else 0
        row["invalid"] += 0 if s["parses"] or trunc else 1
        row["latencies"].append(ms)
        row["in_tok"].append(res.input_tokens)
        row["out_tok"].append(res.output_tokens)
        if res.usd(prov.caps) is None:
            row["cost_known"] = False
        else:
            row["cost_usd"] += res.usd(prov.caps) or 0.0

    if row["latencies"]:
        row["as_ms"] = sum(row["latencies"]) / len(row["latencies"])
    if row["turns"] == 0:
        row["cost_known"] = False
    return row


def verdict(r: dict) -> str:
    """A one-word call, decided on grounding first. The ordering is the point:
    a model that invents marks is disqualified, because that is a wrong click,
    while a slow model is merely annoying."""
    if r["error"]:
        return "UNUSABLE"
    if r["turns"] == 0:
        return "UNUSABLE"
    if r["used_mark"] == 0:
        return "NO GROUNDING"
    if r["invented"]:
        return "INVENTS MARKS"
    if r["invalid"]:
        return "INVALID PLANS"
    if r["truncated"]:
        return "TRUNCATES"
    return "USABLE"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="*", default=[
        "Qwen/Qwen3-VL-8B-Instruct",
        "Qwen/Qwen3-VL-32B-Instruct",
        "Qwen/Qwen3-VL-30B-A3B-Instruct",
    ])
    ap.add_argument("--turns", type=int, default=6)
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--out", default=str(ROOT / "bench" / "results" / "model_comparison.json"))
    a = ap.parse_args()

    cases = plans_for(a.turns)
    if not cases:
        print("  no corpus. Run: python bench/gen_synthetic.py", file=sys.stderr)
        return 2

    print("=" * 92)
    print(f"  MODEL COMPARISON — {len(cases)} Veil planner turns each")
    print(f"  max_tokens ceiling: {os.environ.get('VEIL_LLM_MAX_TOKENS', '8192')} "
          "(a ceiling, not a reservation — you pay only for what is generated)")
    print("=" * 92)

    results: list[dict] = []
    for m in a.models:
        print(f"\n  running {m} …", flush=True)
        r = asyncio.run(run_model(m, cases, a.timeout))
        results.append(r)
        if r["error"]:
            print(f"    {r['error']}")
        else:
            print(f"    {r['parsed']}/{r['turns']} valid · {r['used_mark']}/{r['turns']} marked · "
                  f"{r['invented']} invented · {r['truncated']} truncated · "
                  f"{r['latencies'][0]:.0f}–{r['latencies'][-1]:.0f} ms")

    # ── table ──────────────────────────────────────────────────────────────
    print()
    print("=" * 92)
    print(f"  {'model':40} {'valid':>7} {'mark':>6} {'inv':>5} {'trunc':>6} "
          f"{'p50 ms':>8} {'p95 ms':>8} {'$/turn':>10}  verdict")
    print("-" * 92)
    for r in sorted(results, key=lambda x: (x["error"] is not None, -x["used_mark"])):
        if r["error"] or not r["latencies"]:
            print(f"  {r['model'][:39]:40} {'—':>7} {'—':>6} {'—':>5} {'—':>6} "
                  f"{'—':>8} {'—':>8} {'—':>10}  {verdict(r)}")
            continue
        lat = sorted(r["latencies"])
        p50 = statistics.median(lat)
        p95 = lat[min(len(lat) - 1, int(len(lat) * 0.95))]
        cost = f"${r['cost_usd']/r['turns']:.6f}" if r["cost_known"] else "UNKNOWN"
        print(f"  {r['model'][:39]:40} "
              f"{str(r['parsed'])+'/'+str(r['turns']):>7} "
              f"{str(r['used_mark'])+'/'+str(r['turns']):>6} "
              f"{r['invented']:>5} {r['truncated']:>6} "
              f"{p50:>8.0f} {p95:>8.0f} {cost:>10}  {verdict(r)}")
    print("=" * 92)

    usable = [r for r in results if verdict(r) == "USABLE"]
    if usable:
        fast = min(usable, key=lambda r: statistics.median(r["latencies"]))
        strong = min(
            (r for r in usable if r["parsed"] == r["turns"]),
            key=lambda r: r["out_tok"] and max(r["out_tok"]) or 0,
            default=usable[-1],
        )
        print("\n  READ")
        print(f"    lowest latency that grounds correctly : {fast['model']} "
              f"({statistics.median(fast['latencies']):.0f} ms p50)")
        print(f"    most detailed plans                   : {strong['model']} "
              f"(mean {sum(strong['out_tok'])/len(strong['out_tok']):.0f} output tokens)")
        if fast["model"] != strong["model"]:
            print("    -> they differ. For a live demo, latency wins; for a hard page,")
            print("       plan quality wins. Pick per demo rather than once.")
    else:
        print("\n  no model returned a usable plan. Do NOT ship any of these as the")
        print("  planner — the panel will say so rather than clicking the wrong thing.")

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    for r in results:
        if r["latencies"]:
            lat = sorted(r["latencies"])
            r["p50_ms"] = statistics.median(lat)
            r["p95_ms"] = lat[min(len(lat) - 1, int(len(lat) * 0.95))]
            r["usd_per_turn"] = (r["cost_usd"] / r["turns"]) if r["cost_known"] else None
        r["verdict"] = verdict(r)
    out.write_text(json.dumps({"cases": len(cases), "results": results}, indent=2), encoding="utf-8")
    print(f"\n  wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
