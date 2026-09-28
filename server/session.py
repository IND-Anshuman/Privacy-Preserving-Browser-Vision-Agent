"""Session memory, the bounded replan loop, and cost accounting.

Three things the stateless server lacked, and all three are failure modes
rather than features:

  MEMORY — a multi-step task is a conversation, not a series of independent
  requests. "Actually, use my work address" has nowhere to live today. The
  session keeps the intent, what has been done, and what the user declined —
  the last one especially, because a declined action must not be silently
  re-proposed by the next replan.

  THE LOOP CAP — a step that fails, then replans, then fails again, is an agent
  that will spin until something gives. The cap is the property that makes
  retrying safe at all. Reaching it degrades to `ask_user` with the reason,
  never to a plan that tries again.

  COST — the screenshot is ~74% of input tokens, so a session's price is
  dominated by something the user can actually control. Per-session accounting
  is what makes "we send fewer pixels" a measurable decision rather than a
  slogan.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("veil.session")

#: Hard ceiling on replans for one user intent. A page that cannot be
#: automated is a page to hand back to the human.
DEFAULT_MAX_ATTEMPTS = 3
#: Sessions retained in memory before the oldest is evicted.
MAX_SESSIONS = 256


@dataclass
class Attempt:
    turn: int
    action: str
    ok: bool
    detail: str = ""
    at: float = field(default_factory=time.time)


@dataclass
class Session:
    session_id: str
    intent: str = ""
    #: What has already been done, in order. The prompt gets this so the model
    #: does not re-click a button it already clicked.
    completed: list[str] = field(default_factory=list)
    #: Actions the human said no to. Never re-proposed.
    declined: list[str] = field(default_factory=list)
    #: Failures observed on the client, most recent last.
    failures: list[str] = field(default_factory=list)
    attempts: list[Attempt] = field(default_factory=list)
    #: Cumulative cost in USD. None while the provider reports no pricing.
    cost_usd: float | None = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    turns: int = 0
    started: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)

    def note_attempt(self, turn: int, action: str, ok: bool, detail: str = "") -> None:
        self.attempts.append(Attempt(turn, action, ok, detail))
        self.last_seen = time.time()

    def record_cost(self, in_tok: int, out_tok: int, usd: float | None) -> None:
        self.input_tokens += in_tok
        self.output_tokens += out_tok
        if usd is None:
            # Once pricing is unknown it stays unknown. Reporting 0.0 would
            # read as "free", which is a different and wrong claim.
            self.cost_usd = None
        elif self.cost_usd is not None:
            self.cost_usd += usd

    def exhausted(self, cap: int = DEFAULT_MAX_ATTEMPTS) -> bool:
        return len(self.attempts) >= cap

    def summary(self) -> dict[str, Any]:
        return {
            "turns": self.turns,
            "completed": len(self.completed),
            "declined": len(self.declined),
            "failures": len(self.failures),
            "attempts": len(self.attempts),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
            "age_s": round(time.time() - self.started, 1),
        }


class SessionStore:
    """In-memory sessions with LRU-ish eviction. No persistence, by design.

    A privacy tool that writes user task history to disk has created a new
    dataset to protect. Sessions live in the process and die with it.
    """

    def __init__(self, max_sessions: int = MAX_SESSIONS) -> None:
        self._s: dict[str, Session] = {}
        self.max_sessions = max_sessions

    def get(self, session_id: str) -> Session:
        s = self._s.get(session_id)
        if s is None:
            if len(self._s) >= self.max_sessions:
                oldest = min(self._s.values(), key=lambda x: x.last_seen)
                self._s.pop(oldest.session_id, None)
                log.info("evicted session %s (capacity reached)", oldest.session_id[-8:])
            s = Session(session_id=session_id)
            self._s[session_id] = s
        s.last_seen = time.time()
        return s

    def all(self) -> list[Session]:
        return list(self._s.values())

    def clear(self) -> None:
        self._s.clear()


def escalation_reason(s: Session, cap: int = DEFAULT_MAX_ATTEMPTS) -> str:
    """Plain-English reason for handing control back, or '' to keep going."""
    if not s.failures:
        return ""
    if s.exhausted(cap):
        return (
            f"stopped after {len(s.attempts)} attempt(s): "
            f"{s.failures[-1][:120]}. Handing control back rather than retrying."
        )
    if s.declined:
        return f"you declined a previous step ({s.declined[-1][:80]})."
    return ""
