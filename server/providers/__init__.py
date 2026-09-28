"""Provider adapters. See base.py for the contract and why capabilities are
declared rather than assumed.
"""

from .base import (
    PlanCapabilities,
    PlanRequest,
    PlanResult,
    Planner,
    ProviderRefused,
    ProviderUnavailable,
    SchemaEnforcement,
)
from .fake import FakeProvider, valid_plan
from .local_vllm import LocalVLLMProvider
from .openai_compat import OpenAICompatProvider
from .router import Router

__all__ = [
    "PlanCapabilities",
    "PlanRequest",
    "PlanResult",
    "Planner",
    "ProviderRefused",
    "ProviderUnavailable",
    "SchemaEnforcement",
    "FakeProvider",
    "valid_plan",
    "LocalVLLMProvider",
    "OpenAICompatProvider",
    "Router",
]
