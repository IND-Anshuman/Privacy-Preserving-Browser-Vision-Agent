"""Provider contract — the one place a vision model can differ.

The privacy work is entirely client-side. The server's job is to turn a redacted
page into a validated plan, and that operation is model-shaped but not
model-specific. So every provider implements `Planner`, and nothing above this
layer knows which one is in use.

WHY CAPABILITIES ARE FIRST-CLASS
--------------------------------
Providers do not make the same promises, and pretending otherwise is how a
privacy tool loses its guarantees quietly:

  * OpenAI-compatible endpoints can enforce the ActionPlan schema at the token
    level (`strict: true` json_schema). Others only *ask* for JSON and honour
    it well but not absolutely.
  * Some are ZDR-eligible; some train on your content unless you are on a paid
    tier. (Gemini's free tier explicitly says content may be used to improve
    products.)
  * Vision support, image size ceilings and mark-grounding reliability all vary.

So each provider DECLARES what it can promise, and that declaration travels to
the client inside the manifest. A `requested`-enforcement provider makes the
client validate harder. A non-ZDR provider gets surfaced to the user rather
than assumed away. This is the difference between a privacy product and a
privacy claim.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal, Protocol, runtime_checkable

log = logging.getLogger("veil.providers")

# How strongly a provider guarantees the ActionPlan schema.
#
#   strict    — enforced at generation time; a malformed plan is impossible
#   requested — a schema is supplied and honoured in practice, not guaranteed
#   none      — free-form JSON; the validator is the only gate
SchemaEnforcement = Literal["strict", "requested", "none"]


@dataclass(frozen=True)
class PlanCapabilities:
    """What this provider can be relied upon to do. Declared, not assumed."""

    name: str
    schema_enforcement: SchemaEnforcement
    vision: bool
    #: True when the provider's contract says input is not used for training.
    zdr_eligible: bool
    #: Largest accepted image payload, in bytes. 0 means unknown/unbounded.
    max_image_bytes: int
    #: Whether the model reliably targets elements by our [MARK] numbers.
    #: Measured per model in bench/measure_grounding.py, never guessed.
    grounded_marks: bool
    #: USD per 1M input / output tokens. None when the provider is not metered
    #: (a local vLLM, say), which is itself worth reporting.
    usd_per_mtok_in: float | None = None
    usd_per_mtok_out: float | None = None
    #: Free-form note surfaced in /health and the manifest, for honesty.
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "schema_enforcement": self.schema_enforcement,
            "vision": self.vision,
            "zdr_eligible": self.zdr_eligible,
            "max_image_bytes": self.max_image_bytes,
            "grounded_marks": self.grounded_marks,
            "usd_per_mtok_in": self.usd_per_mtok_in,
            "usd_per_mtok_out": self.usd_per_mtok_out,
            "notes": self.notes,
        }


class PlanRequest:
    """One planning turn. Built by the router from the client's StepRequest."""

    __slots__ = ("system", "user_text", "image_b64", "session_id", "turn", "max_tokens", "temperature")

    def __init__(
        self,
        system: str,
        user_text: str,
        image_b64: str | None,
        session_id: str,
        turn: int,
        max_tokens: int = 512,
        temperature: float = 0.0,
    ) -> None:
        self.system = system
        self.user_text = user_text
        self.image_b64 = image_b64
        self.session_id = session_id
        self.turn = turn
        self.max_tokens = max_tokens
        self.temperature = temperature

    def image_bytes(self) -> int:
        if not self.image_b64:
            return 0
        # base64 expands 3 bytes to 4 chars, minus padding.
        return (len(self.image_b64) * 3) // 4


@dataclass
class PlanResult:
    """A finished plan plus the accounting that makes it auditable."""

    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    #: True when the provider refused rather than answered. A refusal is NOT a
    #: plan and must never be coerced into one — it becomes ask_user.
    refused: bool = False
    refusal_reason: str = ""
    provider: str = ""
    model: str = ""
    ttft_ms: float | None = None
    total_ms: float = 0.0

    def usd(self, caps: PlanCapabilities) -> float | None:
        if caps.usd_per_mtok_in is None or caps.usd_per_mtok_out is None:
            return None
        return (
            self.input_tokens * caps.usd_per_mtok_in + self.output_tokens * caps.usd_per_mtok_out
        ) / 1_000_000


class ProviderUnavailable(RuntimeError):
    """The provider could not be reached or refused the request outright."""


class ProviderRefused(ProviderUnavailable):
    """The provider answered, but declined. Distinct: it is not an error."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@runtime_checkable
class Planner(Protocol):
    """What the router needs from any provider."""

    caps: PlanCapabilities

    async def probe(self) -> bool:
        """Is the provider usable right now? Never raises."""
        ...

    def model_name(self) -> str:
        ...

    async def stream(self, req: PlanRequest) -> AsyncIterator[str]:
        """Yield plan JSON fragments as produced. Raises ProviderUnavailable."""
        ...

    async def complete(self, req: PlanRequest) -> PlanResult:
        """Non-streaming convenience. Adapters may implement this via stream()."""
        ...
