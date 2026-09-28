"""Plan validation and delta re-compositing state — ARCHITECTURE.md §9.

Validation here is a SECOND gate, not a formality. The client already parses
with Zod; this catches a server that drifted, a malformed stream, or a plan
that is schema-valid but semantically unsafe (destructive action, mark that
does not exist, fill into a hidden field).
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field, model_validator

ACTION_NAMES = {
    "click", "fill", "focus", "select", "scroll", "hover",
    "navigate", "extract", "wait_for", "ask_user", "none",
}
FILLABLE = {"fill", "select"}
# Tokens the client mints. A value containing one of these is a placeholder,
# which is safe. A value containing a raw-looking secret is not.
PLACEHOLDER_RE = re.compile(r"^\[[A-Z_]+_\d+\]$|^\[PASSWORD\]$")

# A plan may not name a destructive verb as an executable action. The client
# also guards this, but catching it here means a drifting model cannot route
# around the human confirmation step. §4, §12 risk table
DESTRUCTIVE = re.compile(
    r"\b(submit|send\s+(?:money|payment|message)|pay|delete|remove\s+account|"
    r"place\s+order|confirm\s+order|transfer|wire|close\s+account)\b",
    re.I,
)


class ActionStep(BaseModel):
    action: str
    target: dict[str, Any] | None = None
    value: str | None = None
    text: str | None = None
    url: str | None = None
    direction: str | None = None
    amount: float | None = None
    reason: str | None = None
    confidence: float | None = None


class ActionPlan(BaseModel):
    schema_version: str = "1.0.0"
    session_id: str
    steps: list[ActionStep] = Field(min_length=1, max_length=12)
    confidence: float = Field(ge=0, le=1)
    needs_more_context: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _shape(self) -> "ActionPlan":
        for i, s in enumerate(self.steps):
            if s.action not in ACTION_NAMES:
                raise ValueError(f"step {i}: unknown action {s.action!r}")
            if s.action == "none" and i != len(self.steps) - 1:
                raise ValueError(f"step {i}: 'none' must be the last step")
            if s.action in FILLABLE and not (s.target and s.target.get("mark") is not None):
                raise ValueError(f"step {i}: {s.action} requires target.mark")
            if s.target and s.target.get("mark") is not None and s.target["mark"] < 0:
                raise ValueError(f"step {i}: negative mark")
            # Destructive steps must be handed back to the human, not executed.
            # The verb can appear in the reason, the fill value, or the target
            # name, so all of them are scanned.
            if s.action in ("ask_user", "none"):
                continue
            blob = " ".join(
                str(x) for x in (s.action, s.value, s.text, s.reason, s.url,
                                 (s.target or {}).get("name"), (s.target or {}).get("selector"))
                if x
            )
            hit = DESTRUCTIVE.search(blob)
            if hit:
                raise ValueError(
                    f"step {i}: destructive verb {hit.group(0)!r} must be emitted as ask_user"
                )
        return self


def validate_plan(raw: dict[str, Any]) -> ActionPlan:
    """Parse and validate. Raises ValueError with a human-readable reason."""
    return ActionPlan.model_validate(raw)


def check_plan_against_state(plan: ActionPlan, screen_state: dict[str, Any]) -> list[str]:
    """Semantic checks that need the screen state.

    Returns a list of problems; an empty list means the plan is safe to run.
    """
    problems: list[str] = []
    valid_marks = collect_marks(screen_state.get("root", {}))
    sensitive_marks = collect_sensitive_marks(screen_state.get("root", {}))

    for i, s in enumerate(plan.steps):
        mark = (s.target or {}).get("mark")
        if mark is None:
            continue
        if valid_marks and mark not in valid_marks:
            problems.append(f"step {i}: mark {mark} does not exist on this page")
        if s.action in FILLABLE and mark in sensitive_marks:
            problems.append(f"step {i}: refusing to {s.action} a sensitive field (mark {mark})")
        if s.action == "fill" and s.value:
            # A placeholder is fine. A long opaque string into a hidden field is
            # the exact thing the architecture forbids.
            if not PLACEHOLDER_RE.match(s.value.strip()) and len(s.value) > 3:
                if mark in sensitive_marks:
                    problems.append(f"step {i}: value looks raw for a sensitive field")
    return problems


def collect_marks(node: dict[str, Any]) -> set[int]:
    out: set[int] = set()
    if not isinstance(node, dict):
        return out
    if node.get("mark") is not None:
        out.add(int(node["mark"]))
    for c in node.get("children", []) or []:
        out |= collect_marks(c)
    return out


def collect_sensitive_marks(node: dict[str, Any]) -> set[int]:
    out: set[int] = set()
    if not isinstance(node, dict):
        return out
    if node.get("valueClass") == "sensitive" and node.get("mark") is not None:
        out.add(int(node["mark"]))
    for c in node.get("children", []) or []:
        out |= collect_sensitive_marks(c)
    return out
