"""A provider that needs no network and no key.

Every test in this project should be able to run with no API key configured,
because a test suite that requires a paid API is a test suite that stops being
run. This also makes the failure paths testable: a provider that refuses, one
that is unreachable, and one that returns a schema-violating plan are all just
configurations here.

`script` is a list of responses returned in order, cycling once exhausted, so a
test can say "first turn fails, second succeeds" without any timing tricks.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

from .base import PlanCapabilities, PlanRequest, PlanResult, ProviderUnavailable


def valid_plan(session_id: str, **over: Any) -> str:
    """A schema-valid plan, for tests that need the happy path."""
    plan = {
        "schema_version": "1.0.0",
        "session_id": session_id,
        "steps": [{"action": "none", "reason": "fake provider"}],
        "confidence": 0.9,
        "needs_more_context": [],
    }
    plan.update(over)
    return json.dumps(plan)


class FakeProvider:
    """Scripted provider. No sockets, no keys, deterministic."""

    def __init__(
        self,
        script: list[str] | None = None,
        *,
        available: bool = True,
        caps: PlanCapabilities | None = None,
        input_tokens: int = 1900,
        output_tokens: int = 120,
    ) -> None:
        self.script = list(script) if script else [valid_plan("fake-session")]
        self._i = 0
        self.available = available
        self.calls: list[PlanRequest] = []
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.caps = caps or PlanCapabilities(
            name="fake",
            schema_enforcement="strict",
            vision=True,
            zdr_eligible=True,
            max_image_bytes=0,
            grounded_marks=True,
            usd_per_mtok_in=0.0,
            usd_per_mtok_out=0.0,
            notes="scripted fake for tests",
        )

    def model_name(self) -> str:
        return "fake-model"

    async def probe(self) -> bool:
        return self.available

    def _next(self) -> str:
        out = self.script[min(self._i, len(self.script) - 1)]
        self._i += 1
        return out

    async def stream(self, req: PlanRequest) -> AsyncIterator[str]:
        self.calls.append(req)
        if not self.available:
            raise ProviderUnavailable("fake provider is configured unavailable")
        text = self._next()
        # Emit in fragments so the streaming path is genuinely exercised rather
        # than short-circuited by a single whole-string yield.
        for i in range(0, len(text), 64):
            yield text[i : i + 64]

    async def complete(self, req: PlanRequest) -> PlanResult:
        self.calls.append(req)
        if not self.available:
            raise ProviderUnavailable("fake provider is configured unavailable")
        return PlanResult(
            text=self._next(),
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            provider=self.caps.name,
            model="fake-model",
            total_ms=1.0,
        )
