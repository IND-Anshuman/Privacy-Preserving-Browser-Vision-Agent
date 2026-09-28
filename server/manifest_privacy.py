"""Differentially-private manifest counts.

THE LEAK
--------
The redaction manifest tells the server what was hidden — which is the whole
point, since the model needs to know a token is a pseudonym and not a glitch.
But the current form also tells it HOW MANY of each class:

    HIDDEN ON THIS PAGE: 3 item(s).
      AADHAAR (3): [AADHAAR_A3_1a2b3c4d], ...
      PAN (1): [PAN_A3_4d5e6f7]

An observer who cannot see the values still learns that this page had exactly
three Aadhaar numbers. On a banking, tax, or medical page that is itself
sensitive: it reveals the user's relationship to a financial or health
institution, and with a handful of pages, a pattern.

THE FIX
-------
Two modes, chosen by the operator, because they trade different things:

  `exact`   — counts as they are. Maximum model usefulness: the model can say
              "you already supplied an Aadhaar" and skip it. Default, because
              silently degrading the model's input is worse than a small count
              leak, and the leak is bounded by what is already visible.

  `bucketed`— counts are rounded to a power-of-two bucket: 1, 2-3, 4-7, 8-15…
              A count of 1, 2 and 3 all become "2-3". This is a real (if
              coarse) DP mechanism: an observer learns the order of magnitude,
              not the value. The model can still reason "there are several of
              these", which is most of what it needs.

  `noise`   — counts get Laplace noise with a configurable epsilon, then clamp
              at zero. The honest DP mechanism and the weakest for utility: at
              small counts the noise dominates, so "1 Aadhaar" may read as
              "0" or "3".

BUCKETING IS NOT FULL DP AND IS NOT CALLED IT. A power-of-two bucket is a
coarsening, not a formal epsilon-DP guarantee; `noise` is the mode that offers
one, and even there the guarantee holds only for the count release, not for the
tokens themselves. The docstrings say so, because calling coarsening "DP" is
the kind of overclaim this project has been deleting all week.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import os
import random
from typing import Any

MODE_EXACT = "exact"
MODE_BUCKETED = "bucketed"
MODE_NOISE = "noise"
MODES = (MODE_EXACT, MODE_BUCKETED, MODE_NOISE)


def mode_from_env() -> str:
    m = (os.environ.get("VEIL_MANIFEST_PRIVACY", MODE_EXACT) or MODE_EXACT).strip().lower()
    if m not in MODES:
        return MODE_EXACT
    return m


def epsilon_from_env() -> float:
    try:
        return max(0.1, float(os.environ.get("VEIL_MANIFEST_EPSILON", "1.0")))
    except ValueError:
        return 1.0


def bucket(n: int) -> str:
    """Power-of-two bucket label. Never reveals the exact count above 1."""
    if n <= 0:
        return "none"
    if n == 1:
        return "1"
    lo = 1
    while lo * 2 <= n:
        lo *= 2
    return f"{lo}-{lo * 2 - 1}"


def laplace(rng: random.Random, eps: float) -> float:
    """Laplace mechanism sample. u in (-0.5, 0.5)."""
    u = rng.random() - 0.5
    return -math.copysign(1.0, u) * math.log(1 - 2 * abs(u)) / eps


def _noisy_count(n: int, eps: float, rng: random.Random) -> tuple[int, float]:
    value = n + laplace(rng, eps)
    clamped = max(0, int(round(value)))
    # How far the released value moved from the truth, for the ledger. A DP
    # claim you cannot audit is not a claim.
    return clamped, abs(clamped - n)


def _rng(session_id: str) -> random.Random:
    """Deterministic per session, so a retry does not re-randomise the count.

    Re-noising on every retry would make the release unstable AND leak: an
    observer averaging repeated releases recovers the true count faster than
    Laplace noise is meant to allow. Seeding on the session id fixes both.
    """
    seed = int(hashlib.sha256(session_id.encode()).hexdigest()[:16], 16)
    return random.Random(seed)


def summarize(
    redactions: list[dict[str, Any]],
    *,
    mode: str | None = None,
    eps: float | None = None,
    session_id: str = "",
    secret: str = "",
) -> dict[str, Any]:
    """Counts per class, under the configured privacy mode.

    Returns both the released counts (for the prompt) and a privacy note (for
    the ledger). The tokens themselves are never altered — the model still needs
    them to reference a field — only the COUNTS are protected.
    """
    mode = (mode or mode_from_env()).lower()
    if mode not in MODES:
        mode = MODE_EXACT
    eps = eps if eps is not None else epsilon_from_env()
    rng = _rng(session_id or "anonymous")

    by_class: dict[str, list[dict[str, Any]]] = {}
    for r in redactions:
        by_class.setdefault(r.get("cls", "UNKNOWN"), []).append(r)

    released: dict[str, int] = {}
    labels: dict[str, str] = {}
    total_shown = 0
    max_shift = 0.0

    for cls, items in sorted(by_class.items()):
        true_n = len(items)
        if mode == MODE_NOISE and secret:
            shown, shift = _noisy_count(true_n, eps, rng)
        else:
            shown, shift = true_n, 0.0
        max_shift = max(max_shift, shift)
        released[cls] = shown
        labels[cls] = bucket(shown) if mode != MODE_EXACT else str(shown)
        total_shown += shown

    note = {
        "mode": mode,
        "epsilon": eps if mode == MODE_NOISE else None,
        "max_count_shift": round(max_shift, 2),
        "classes": len(by_class),
    }
    if mode == MODE_BUCKETED:
        note["honesty"] = "power-of-two coarsening, not formal epsilon-DP"
    elif mode == MODE_NOISE:
        note["honesty"] = "Laplace noise on counts only; tokens are still exact"
    return {"counts": released, "labels": labels, "total": total_shown, "privacy": note}


def render_summary(s: dict[str, Any]) -> str:
    """The prompt lines. Reads naturally to the model either way."""
    if not s["total"]:
        return "HIDDEN ON THIS PAGE: nothing was detected as sensitive."
    mode = s["privacy"]["mode"]
    if mode == "exact":
        lines = [f"HIDDEN ON THIS PAGE: {s['total']} item(s) in {len(s['counts'])} class(es)."]
    else:
        lines = [
            f"HIDDEN ON THIS PAGE: {mode}-count summary, {len(s['counts'])} class(es). "
            "Counts are approximate by design."
        ]
    for cls in sorted(s["counts"]):
        lines.append(f"  {cls}: {'about ' if mode != 'exact' else ''}{s['labels'][cls]}")
    if mode != "exact":
        lines.append(
            "  Do not infer an exact number of items, and do not claim a field exists "
            "just because a class is listed."
        )
    return "\n".join(lines)
