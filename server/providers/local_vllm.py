"""Local vLLM — the pre-existing path, unchanged in behaviour, now behind the
same interface as the hosted providers.

Kept separate from `openai_compat.py` even though both speak
`/v1/chat/completions`, because they differ in ways that matter:

  * vLLM takes guided decoding via `guided_decoding` with the xgrammar backend,
    which enforces the schema at the TOKEN level. That is `strict`, not
    `requested`, so the two must not share a code path that could quietly
    downgrade one to the other's guarantee.
  * No API key, no cost, and — importantly for a privacy product — no data
    leaves the machine.

A local endpoint is the strongest privacy position available, so it stays
first-class rather than being folded into the "OpenAI-compatible" bucket.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, AsyncIterator

import httpx

from .base import PlanCapabilities, PlanRequest, PlanResult, ProviderUnavailable
from ..vllm_client import ACTION_PLAN_JSON_SCHEMA

log = logging.getLogger("veil.providers.local")

VLLM_BASE = os.environ.get("VLLM_BASE_URL", "http://127.0.0.1:8001").rstrip("/")
MODEL_NAME = os.environ.get("VLLM_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct")
TIMEOUT_S = float(os.environ.get("VLLM_TIMEOUT_S", "60"))


class LocalVLLMProvider:
    """Qwen2.5-VL (or any local vision model) via xgrammar-constrained decoding."""

    def __init__(self) -> None:
        self.base_url = VLLM_BASE
        self.model = MODEL_NAME
        self.caps = PlanCapabilities(
            name="local-vllm",
            schema_enforcement="strict",  # xgrammar is a token-level guarantee
            vision=True,
            zdr_eligible=True,  # nothing leaves the machine
            max_image_bytes=0,
            grounded_marks=False,  # unmeasured — do not claim it
            usd_per_mtok_in=None,  # not metered, which is worth reporting as-is
            usd_per_mtok_out=None,
            notes="local xgrammar decoding; nothing leaves the host",
        )
        self.available: bool | None = None
        self.engine_summary: str = "unprobed"
        self._client: httpx.AsyncClient | None = None

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=TIMEOUT_S)
        return self._client

    def model_name(self) -> str:
        return self.model

    async def probe(self) -> bool:
        try:
            c = await self._http()
            r = await c.get(f"{self.base_url}/v1/models", timeout=5.0)
            if r.status_code == 200:
                data = r.json()
                names = [m.get("id") for m in data.get("data", [])]
                self.available = True
                self.engine_summary = f"vLLM serving {names[0] if names else self.model}"
            else:
                self.available = False
                self.engine_summary = f"vLLM reachable but returned {r.status_code}"
        except Exception as e:  # noqa: BLE001
            self.available = False
            self.engine_summary = f"vLLM unreachable ({type(e).__name__})"
        return bool(self.available)

    def _payload(self, req: PlanRequest, stream: bool) -> dict[str, Any]:
        content: list[dict[str, Any]] = [{"type": "text", "text": req.user_text}]
        if req.image_b64:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/webp;base64,{req.image_b64}"},
                }
            )
        return {
            "model": self.model,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": content},
            ],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "stream": stream,
            "guided_decoding": {"backend": "xgrammar", "json": ACTION_PLAN_JSON_SCHEMA},
        }

    async def stream(self, req: PlanRequest) -> AsyncIterator[str]:
        if self.available is None:
            await self.probe()
        if not self.available:
            raise ProviderUnavailable(self.engine_summary)

        c = await self._http()
        try:
            async with c.stream(
                "POST", f"{self.base_url}/v1/chat/completions", json=self._payload(req, True)
            ) as r:
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", "replace")[:300]
                    raise ProviderUnavailable(f"vLLM {r.status_code}: {body}")
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data.strip() == "[DONE]":
                        return
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    for ch in obj.get("choices", []):
                        piece = (ch.get("delta") or {}).get("content")
                        if piece:
                            yield piece
        except httpx.HTTPError as e:
            raise ProviderUnavailable(str(e)) from e

    async def complete(self, req: PlanRequest) -> PlanResult:
        if self.available is None:
            await self.probe()
        if not self.available:
            raise ProviderUnavailable(self.engine_summary)
        c = await self._http()
        t0 = time.perf_counter()
        try:
            r = await c.post(
                f"{self.base_url}/v1/chat/completions", json=self._payload(req, False)
            )
        except httpx.HTTPError as e:
            raise ProviderUnavailable(str(e)) from e
        elapsed = (time.perf_counter() - t0) * 1000
        if r.status_code != 200:
            raise ProviderUnavailable(f"vLLM {r.status_code}: {r.text[:300]}")
        body = r.json()
        usage = body.get("usage") or {}
        text = "".join(
            (ch.get("message") or {}).get("content") or "" for ch in body.get("choices") or []
        )
        return PlanResult(
            text=text,
            input_tokens=int(usage.get("prompt_tokens") or 0),
            output_tokens=int(usage.get("completion_tokens") or 0),
            provider=self.caps.name,
            model=self.model,
            total_ms=elapsed,
        )
