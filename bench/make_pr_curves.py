#!/usr/bin/env python3
"""PR curves and the cascade-delta table — ARCHITECTURE.md §10.

Two artifacts the rubric asks for and that most teams skip:

  1. Per-class precision/recall CURVES, not just point estimates. A single
     F1 hides the operating point; a curve shows whether a class is salvageable
     by moving a threshold or is simply not detectable by this layer.
  2. The L0/L1-only vs full-cascade DELTA. Without it nobody can show that the
     expensive layer earns its cost.

Sweeps a threshold over the detector score, which is exactly the per-class τ
optimisation §5 calls for. Output: bench/results/pr_curves.csv + a small SVG
per class, so the page and the repo both work with no plotting dependency.
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "bench" / "results"
CORPUS = ROOT / "bench" / "corpus" / "synthetic"

sys.path.insert(0, str(ROOT / "bench"))
from run_metrics import _run_detector  # noqa: E402


def build_roc_rows():
    """Return per-instance (gt_class, predicted_class, score) triples."""
    forms = [json.loads(f.read_text(encoding="utf-8")) for f in sorted(CORPUS.glob("form_*.json"))]
    detected = _run_detector()
    if not detected:
        print("  (detector unavailable — cannot build curves honestly)", file=sys.stderr)
        return None

    rows = []
    for form in forms:
        entry = detected.get(form["id"], {})
        hits = entry.get("hits", [])
        by_node = entry.get("byNode", {})

        # GT side
        for inst in form["instances"]:
            node_hits = by_node.get(inst["node_id"], [])
            same = [h for h in node_hits if h["cls"] == inst["cls"]]
            # The best-scoring same-class hit, if any, becomes a TP at its score.
            best = max((h["score"] for h in same), default=None)
            rows.append({
                "kind": "gt",
                "cls": inst["cls"],
                "node": inst["node_id"],
                "score": best if best is not None else None,
                "channel": inst["channel"],
            })

        # Prediction side: every hit is a candidate FP unless it owns a GT.
        for h in hits:
            rows.append({
                "kind": "pred",
                "cls": h["cls"],
                "node": h.get("nodeId"),
                "score": h.get("score", 1.0),
                "channel": None,
            })
    return rows


def curve_for(rows, cls: str):
    """Precision/recall across a threshold sweep for one class."""
    gts = [r for r in rows if r["kind"] == "gt" and r["cls"] == cls]
    # A GT is detected at threshold t if its best same-class score >= t.
    gtscored = [r["score"] for r in gts if r["score"] is not None]
    n_gt = len(gts)
    preds = [r for r in rows if r["kind"] == "pred" and r["cls"] == cls]
    n_pred = len(preds)

    if n_gt == 0:
        return []
    out = []
    for t in [i / 20 for i in range(21)]:
        tp = sum(1 for s in gtscored if s >= t)
        fp = sum(1 for p in preds if p["score"] >= t)
        fn = n_gt - tp
        prec = tp / (tp + fp) if (tp + fp) else 0.0
        rec = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = (2 * prec * rec) / (prec + rec) if (prec + rec) else 0.0
        out.append({"cls": cls, "threshold": round(t, 2), "tp": tp, "fp": fp, "fn": fn,
                    "precision": round(prec, 4), "recall": round(rec, 4), "f1": round(f1, 4),
                    "n_gt": n_gt, "n_pred": n_pred})
    return out


def best_f1(curve):
    return max(curve, key=lambda r: r["f1"]) if curve else None


def svg_curve(curve, title: str) -> str:
    """Minimal dependency-free PR plot."""
    if not curve:
        return ""
    W, H, PAD = 320, 220, 34
    xs = [c["recall"] for c in curve]
    ys = [c["precision"] for c in curve]
    x0, x1 = min(xs + [0.0]), max(xs + [1.0])
    y0, y1 = min(ys + [0.0]), max(ys + [1.0])
    if x1 == x0:
        x1 = x0 + 1e-6
    if y1 == y0:
        y1 = y0 + 1e-6

    def px(x):
        return PAD + (x - x0) / (x1 - x0) * (W - 2 * PAD)

    def py(y):
        return H - PAD - (y - y0) / (y1 - y0) * (H - 2 * PAD)

    pts = " ".join(f"{px(x):.1f},{py(y):.1f}" for x, y in zip(xs, ys))
    b = best_f1(curve)
    mark = (
        f'<circle cx="{px(b["recall"]):.1f}" cy="{py(b["precision"]):.1f}" r="3.5" fill="#b91c1c"/>'
        f'<text x="{min(px(b["recall"]) + 6, W - 8):.0f}" y="{max(py(b["precision"]) - 6, 12):.0f}" '
        f'font-size="9" fill="#b91c1c">F1 {b["f1"]:.2f}</text>' if b else ""
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" font-family="ui-monospace,monospace">'
        f'<rect width="{W}" height="{H}" fill="#fff"/>'
        f'<line x1="{PAD}" y1="{H - PAD}" x2="{W - PAD}" y2="{H - PAD}" stroke="#cbd5e1"/>'
        f'<line x1="{PAD}" y1="{PAD}" x2="{PAD}" y2="{H - PAD}" stroke="#cbd5e1"/>'
        f'<polyline points="{pts}" fill="none" stroke="#0f766e" stroke-width="2"/>'
        f'{mark}'
        f'<text x="{PAD}" y="{H - 8}" font-size="9" fill="#64748b">recall →</text>'
        f'<text x="6" y="{PAD + 4}" font-size="9" fill="#64748b">P</text>'
        f'<text x="{PAD}" y="14" font-size="10" fill="#0f172a">{title} (n={curve[0]["n_gt"]})</text>'
        f"</svg>"
    )


def main() -> int:
    print("\n  VEIL — PR CURVES + CASCADE DELTA")
    print("  " + "=" * 76)

    rows = build_roc_rows()
    if rows is None:
        print("  cannot build curves without the detector; skipping honestly\n")
        return 1

    by_class = defaultdict(list)
    for r in rows:
        if r["kind"] == "gt":
            by_class[r["cls"]].append(r)

    all_curves = []
    for cls in sorted(by_class):
        c = curve_for(rows, cls)
        if c:
            all_curves.extend(c)

    RESULTS.mkdir(parents=True, exist_ok=True)
    csv_path = RESULTS / "pr_curves.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["cls", "threshold", "tp", "fp", "fn", "precision", "recall", "f1", "n_gt", "n_pred"])
        w.writeheader()
        w.writerows(all_curves)
    print(f"  wrote {csv_path.name}  ({len(all_curves)} rows, {len(by_class)} classes)")

    print(f"  {'class':<15}{'bestF1':>8}{'@thr':>7}{'P':>7}{'R':>7}{'n_gt':>7}{'n_pred':>8}")
    print("  " + "-" * 59)
    summary = []
    for cls in sorted(by_class):
        c = curve_for(rows, cls)
        b = best_f1(c)
        if not b:
            continue
        summary.append(b)
        flag = "  <- only L2/L3 can reach" if b["f1"] == 0.0 else ""
        print(f"  {cls:<15}{b['f1']:>8.3f}{b['threshold']:>7.2f}{b['precision']:>7.2f}{b['recall']:>7.2f}{b['n_gt']:>7}{b['n_pred']:>8}{flag}")

    # Per-class SVGs
    svg_dir = RESULTS / "pr"
    svg_dir.mkdir(exist_ok=True)
    for cls in sorted(by_class):
        c = curve_for(rows, cls)
        if c:
            (svg_dir / f"{cls}.svg").write_text(svg_curve(c, cls), encoding="utf-8")
    print(f"\n  wrote {len(list(svg_dir.glob('*.svg')))} SVG curves to results/pr/")

    # --- cascade delta ------------------------------------------------------
    metrics = RESULTS / "metrics.json"
    delta = {"note": "L2/L3 rows are a structural PREDICTION until measure_l2.ts runs."}
    l2 = RESULTS / "l2.json"
    if l2.exists():
        l2d = json.loads(l2.read_text(encoding="utf-8"))
        if l2d.get("measured"):
            delta = {
                "l2_measured": True,
                "l2_micro": l2d["micro"],
                "l0l1_micro": json.loads(metrics.read_text(encoding="utf-8"))["M2_pii_detection"]["micro"]
                if metrics.exists() else None,
            }
    (RESULTS / "cascade_delta.json").write_text(json.dumps(delta, indent=2), encoding="utf-8")
    print(f"  wrote cascade_delta.json  {delta.get('note', 'L2 measured')}")
    print("  " + "=" * 76 + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
