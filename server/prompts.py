"""Redaction-aware system preamble — ARCHITECTURE.md §9.

The manifest is not documentation. It is the model's operating contract, and it
is rebuilt from scratch every turn so the (byte-identical) preamble is a perfect
prefix-cache hit under --enable-prefix-caching. §8.4
"""

from __future__ import annotations

import json
from typing import Any

try:
    from .vllm_client import REDACTION_CONTRACT
except ImportError:  # running as a script (cwd=server/), not as `server.prompts`
    from vllm_client import REDACTION_CONTRACT

BASE_SYSTEM = """You are Veil, a browser assistant that acts on a page the user is looking at.

You are given three things:
  1. SCREEN_STATE — a pruned accessibility tree. Interactive elements carry a
     numbered [MARK]. That number is the ONLY reliable way to target something.
  2. A redacted screenshot of the same page, with the same marks burned in.
  3. A redaction manifest describing what was hidden before you ever saw it.

Targeting rules:
  • Prefer `target.mark`. Never invent a mark number; if none fits, use `none`.
  • Marks are re-derived every cycle. A plan may be stale by the time it runs.
  • One action per step. Order matters: wait_for before clicking something
    that only appears after an earlier step.
  • `fill` requires a target mark AND a value. Never fill a sensitive field —
    emit ask_user instead.
  • If the page looks finished, wrong, or ambiguous, `none` is a correct and
    expected answer. A wrong click is far worse than no click.
"""

DESTRUCTIVE_NOTE = (
    "Destructive steps (submit, send, pay, delete) MUST be emitted as "
    "`ask_user` with a plain-English reason. The client will ask the human for "
    "confirmation; do not try to work around it."
)


def build_system_preamble(manifest: dict[str, Any]) -> str:
    """Rebuild the preamble from the manifest. Deterministic and compact."""
    redactions = manifest.get("redactions", []) or []
    by_class: dict[str, list[str]] = {}
    for r in redactions:
        tok = (r.get("placeholder") or {}).get("token", "[REDACTED]")
        by_class.setdefault(r.get("cls", "UNKNOWN"), []).append(tok)

    lines = [BASE_SYSTEM, "", REDACTION_CONTRACT, ""]

    if not redactions:
        lines.append("HIDDEN ON THIS PAGE: nothing was detected as sensitive.")
    else:
        total = len(redactions)
        lines.append(f"HIDDEN ON THIS PAGE: {total} item(s). Treated as absolute:")
        for cls in sorted(by_class):
            toks = by_class[cls]
            shown = ", ".join(toks[:6]) + (" …" if len(toks) > 6 else "")
            lines.append(f"  {cls} ({len(toks)}): {shown}")
        if any(r.get("pixel_derived") for r in redactions):
            lines.append(
                "  NOTE: some hidden items were only visible in the image "
                "(canvas, photo, or video). They have no DOM equivalent, so do "
                "not claim a field exists for them."
            )

    lines.append("")
    lines.append(DESTRUCTIVE_NOTE)
    lines.append("")
    lines.append(
        f"Frame fingerprint {str(manifest.get('frame_hash',''))[:12]}. "
        f"Client models: {json.dumps(manifest.get('model_versions', {}))}."
    )
    return "\n".join(lines)
