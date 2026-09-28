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

try:
    from .manifest_privacy import render_summary as _render_summary
    from .manifest_privacy import summarize as summarize_redactions
    from .session import escalation_reason
except ImportError:  # pragma: no cover - script-mode fallback
    from manifest_privacy import render_summary as _render_summary
    from manifest_privacy import summarize as summarize_redactions
    from session import escalation_reason


def render_summary(summary: dict[str, Any]) -> str:
    """Thin alias so the prompt module reads uniformly."""
    return _render_summary(summary)

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


def build_system_preamble(
    manifest: dict[str, Any],
    *,
    session: Any = None,
    capabilities: Any = None,
    injection: str = "",
) -> str:
    """Rebuild the preamble from the manifest. Deterministic and compact.

    Four additions over the original, each earning its place:

    * counts go through `manifest_privacy`, so the operator can coarsen or noise
      them without touching this file;
    * session memory, so a multi-step task is not re-planned from scratch;
    * an injection note when the page contains instruction-shaped text;
    * the provider's declared capabilities, so the model knows whether it is
      being strict-constrained or merely asked.
    """
    redactions = manifest.get("redactions", []) or []
    session_id = str(manifest.get("session_id", ""))

    lines = [BASE_SYSTEM, "", REDACTION_CONTRACT, ""]

    if not redactions:
        lines.append("HIDDEN ON THIS PAGE: nothing was detected as sensitive.")
    else:
        summary = summarize_redactions(redactions, session_id=session_id)
        lines.append(render_summary(summary))
        by_class: dict[str, list[str]] = {}
        for r in redactions:
            tok = (r.get("placeholder") or {}).get("token", "[REDACTED]")
            by_class.setdefault(r.get("cls", "UNKNOWN"), []).append(tok)
        for cls in sorted(by_class):
            toks = by_class[cls]
            shown = ", ".join(toks[:6]) + (" …" if len(toks) > 6 else "")
            lines.append(f"  {cls} tokens: {shown}")
        if any(r.get("pixel_derived") for r in redactions):
            lines.append(
                "  NOTE: some hidden items were only visible in the image "
                "(canvas, photo, or video). They have no DOM equivalent, so do "
                "not claim a field exists for them."
            )

    if injection:
        lines.append("")
        lines.append(injection)

    if session is not None and (session.completed or session.declined or session.failures):
        lines.append("")
        lines.append("SESSION STATE (this is a continuing task, not a fresh one):")
        if session.completed:
            done = "; ".join(session.completed[-5:])
            lines.append(f"  already done: {done}")
        if session.declined:
            # The important one. A declined step must not be re-proposed; that
            # is how an agent ends up nagging a user who already said no.
            lines.append(
                "  the user DECLINED these — do not propose them again: "
                + "; ".join(session.declined[-3:])
            )
        if session.failures:
            lines.append(f"  last failure: {session.failures[-1][:160]}")
        reason = escalation_reason(session)
        if reason:
            lines.append(f"  {reason}")

    lines.append("")
    lines.append(DESTRUCTIVE_NOTE)

    if capabilities is not None:
        lines.append("")
        if getattr(capabilities, "schema_enforcement", "strict") != "strict":
            lines.append(
                "Your output is parsed as JSON but not hard-constrained. Be exact: "
                "use only the documented action names and fields."
            )
        if getattr(capabilities, "vision", True):
            lines.append(
                "The image is the REDACTED screen. Use it to understand layout and to "
                "confirm which mark is which; the numbered [MARK]s in the tree are the "
                "authoritative targets."
            )
        else:
            lines.append(
                "This endpoint cannot see images. You have the structure only — rely on "
                "[MARK] numbers and say so in needs_more_context if a visual check is required."
            )

    lines.append("")
    lines.append(
        f"Frame fingerprint {str(manifest.get('frame_hash',''))[:12]}. "
        f"Client models: {json.dumps(manifest.get('model_versions', {}))}."
    )
    return "\n".join(lines)
