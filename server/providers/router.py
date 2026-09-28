"""Provider selection — and the honesty layer around it.

Selection order, and why:

1. `VEIL_LLM_PROVIDER=local|openai` pins one. Pinning is the operator's
   prerogative: "my screen goes to this endpoint and nowhere else" is a promise
   this project cares about more than cleverness.
2. Otherwise, a local vLLM is preferred when reachable. Nothing leaving the
   machine is the strongest position available, so it wins by default.
3. Otherwise the configured OpenAI-compatible endpoint.

Every fallback is REPORTED, never silent. A turn served by a different provider
than the one the user thinks is serving it is a privacy surprise, so the
selected provider's name and capabilities travel in the manifest and in the SSE
metadata the client shows in its HUD.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from .base import PlanCapabilities, PlanRequest, PlanResult, ProviderUnavailable
from .fake import FakeProvider
from .local_vllm import LocalVLLMProvider
from .openai_compat import OpenAICompatProvider

log = logging.getLogger("veil.router")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip().lower()


class Router:
    """Holds the candidate providers and picks one per turn."""

    def __init__(self, providers: list[Any] | None = None) -> None:
        if providers is not None:
            self.providers = providers
        else:
            self.providers = self._build_default()
        #: Last selection, for /health and tests.
        self.selected: str = ""

    @staticmethod
    def _build_default() -> list[Any]:
        pref = _env("VEIL_LLM_PROVIDER", "auto")
        local = LocalVLLMProvider()
        compat = OpenAICompatProvider()
        if pref == "local":
            return [local]
        if pref == "openai":
            return [compat]
        if pref == "fake":
            return [FakeProvider()]
        return [local, compat]

    def caps(self) -> PlanCapabilities:
        """The capabilities of whatever is currently selected."""
        for p in self.providers:
            if getattr(p, "selected_active", False) or self.selected == p.caps.name:
                return p.caps
        return self.providers[0].caps

    async def resolve(self) -> Any:
        """Pick a usable provider, probing in order. Caches the outcome."""
        for p in self.providers:
            p.selected_active = False
        for p in self.providers:
            ok = False
            try:
                ok = await p.probe()
            except Exception as e:  # noqa: BLE001
                log.warning("provider %s probe raised %s", p.caps.name, type(e).__name__)
                ok = False
            p.selected_active = ok
            if ok:
                self.selected = p.caps.name
                return p
        self.selected = "none"
        return None

    def active(self) -> Any | None:
        for p in self.providers:
            if getattr(p, "selected_active", False):
                return p
        return None

    async def complete(self, req: PlanRequest) -> PlanResult:
        p = await self.resolve()
        if p is None:
            raise ProviderUnavailable("no configured provider is reachable")
        return await p.complete(req)


__all__ = [
    "Router",
    "PlanRequest",
    "PlanResult",
    "PlanCapabilities",
    "ProviderUnavailable",
    "FakeProvider",
    "LocalVLLMProvider",
    "OpenAICompatProvider",
]
