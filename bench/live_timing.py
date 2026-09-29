"""Time the two paths a user actually waits on, against the CONFIGURED model.

The client-side measurement (extension/bench/measure_scan_latency.ts) times
our own compute. It cannot time the two things a user perceives as a wait:

    T0  "describe this page"   — answered on-device by Chrome's Prompt API
    T1  "fill and submit"      — a real HTTP round trip to the planner

T0 cannot be measured here at all: it needs a real Chrome with the Prompt API
and a downloaded model, and stubbing it measures the stub. It is left NOT
MEASURED rather than guessed.

T1 CAN be measured, and it is the number that decides whether the product
feels instant. It is measured over several rounds because the first request
pays for provider-side model warmup and a single sample would flatter it.

    ./.venv/Scripts/python.exe bench/live_timing.py --port 8031
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bench"))
import live_task as LT  # noqa: E402

ROUNDS = int(os.environ.get("VEIL_TIMING_ROUNDS", "5"))


def pct(xs: list[float], p: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, int((p / 100) * len(s)))]


def row(label: str, xs: list[float]) -> str:
    return (
        f"  {label:<34} mean {statistics.mean(xs)/1000:7.2f} s   "
        f"p50 {pct(xs,50)/1000:7.2f}   p95 {pct(xs,95)/1000:7.2f}"
    )


def health(base: str) -> dict:
    with urllib.request.urlopen(f"{base}/health", timeout=30) as r:
        return json.load(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8031)
    ap.add_argument("--rounds", type=int, default=ROUNDS)
    ap.add_argument("--intent", default="Fill the city and the postal code, then confirm.",
                    help="measure this intent; keep it non-destructive to time the common path")
    ap.add_argument("--label", default="T1  PLAN ROUND TRIP")
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}"

    h = health(base)
    print()
    print("  VEIL — USER-VISIBLE LATENCY against the configured model")
    print("  " + "=" * 78)
    print(f"  provider {h.get('provider')}   model {h.get('model')}")
    if h.get("provider") is None:
        print("  NOT A MEASUREMENT — no provider reachable")
        return 2
    print()

    # ---- T1: full plan round trip, a fresh session every time so the
    # replan cap never short-circuits a later sample into a fake result.
    t1: list[float] = []
    t1_cold = 0.0
    for i in range(args.rounds):
        text, plan, ms, err = LT.fetch_plan(
            base,
            args.intent,
            session=f"timing-{i:04d}",
        )
        if plan is None:
            print(f"  round {i}: FAILED — {err or 'no plan'}")
            return 1
        if i == 0:
            t1_cold = ms
        t1.append(ms)

    print(f"  {args.label}  (redacted frame -> plan -> validated steps)")
    print(f"  intent: {args.intent}")
    print("  " + "-" * 78)
    print(row(f"first request (cold), n=1", [t1_cold]))
    print(row(f"steady state, n={len(t1)}", t1[1:] if len(t1) > 1 else t1))
    print()
    print(f"  first plan: {json.dumps(plan)[:150]}")
    print()
    print("  " + "=" * 78)
    print("  NOT MEASURED (needs a real Chrome, cannot be stubbed honestly):")
    print("    · T0 'describe this page' — Chrome Prompt API model load +")
    print("      token generation. A stub times the stub.")
    print("    · captureVisibleTab + canvas composite + JPEG encode")
    print("    · L2 NER / L3 detector inference (real ONNX weights + GPU)")
    print()
    print("  Client-side compute IS measured, by")
    print("  extension/bench/measure_scan_latency.ts — see that output.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
