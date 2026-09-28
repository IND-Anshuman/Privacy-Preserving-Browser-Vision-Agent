"""OpenAI-compatible vision provider — works with any endpoint that speaks
`POST /v1/chat/completions` with an `image_url` content part.

CONFIGURATION (all environment variables — nothing hardcoded):

    VEIL_LLM_API_KEY     required unless VEIL_LLM_API_KEY is empty for a
                         local endpoint that ignores auth (e.g. vLLM, Ollama,
                         LM Studio). Empty string is allowed on purpose: a
                         local server should not need a fake key.
    VEIL_LLM_BASE_URL    e.g. https://api.openai.com/v1
                         Default: the existing VEIL_VLLM_BASE_URL, so a
                         pre-existing local setup keeps working untouched.
    VEIL_LLM_MODEL       the model id. MUST be vision-capable; there is no
                         way to verify this from here, so it is the operator's
                         responsibility and is surfaced in /health.
    VEIL_LLM_MODE        strict | json | text   (default: strict)
                         strict -> response_format json_schema with strict:true
                         json   -> response_format json_object
                         text   -> no format, schema enforced by the validator
                         Set this to `json` or `text` for a provider that
                         rejects `json_schema`. That downgrades the declared
                         capability, and the client is told.
    VEIL_LLM_Pricing_IN / VEIL_LLM_PRICING_OUT
                         USD per 1M tokens, for cost accounting. Optional —
                         unset means "unknown", which is reported as unknown
                         rather than as zero.

WHY THE MODE FLAG EXISTS
------------------------
`strict: true` json_schema is the strongest guarantee available: the model
cannot emit a plan that violates the schema. Not every OpenAI-compatible server
implements it, and several reject the unknown `strict` key with a 400. Rather
than guess, the operator picks the mode, and the provider DECLARES the
corresponding enforcement level. A downgrade is visible, not silent.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, AsyncIterator

import httpx

from .base import (
    PlanCapabilities,
    PlanRequest,
    PlanResult,
    ProviderUnavailable,
)
from ..vllm_client import ACTION_PLAN_JSON_SCHEMA

log = logging.getLogger("veil.providers.openai")

_ENFORCEMENT = {"strict": "strict", "json": "requested", "text": "none"}


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_float(name: str) -> float | None:
    raw = _env(name)
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        log.warning("%s=%r is not a number; treating pricing as unknown", name, raw)
        return None


class OpenAICompatProvider:
    """Any OpenAI-compatible vision endpoint. The default provider."""

    def __init__(self) -> None:
        self.api_key = _env("VEIL_LLM_API_KEY")
        self.base_url = (
            _env("VEIL_LLM_BASE_URL")
            or _env("VEIL_VLLM_BASE_URL")
            or "http://127.0.0.1:8001"
        ).rstrip("/")
        self.model = _env("VEIL_LLM_MODEL") or _env("VLLM_MODEL") or "gpt-4o-mini"
        self.mode = (_env("VEIL_LLM_MODE") or "strict").lower()
        if self.mode not in _ENFORCEMENT:
            log.warning(
                "VEIL_LLM_MODE=%r is not one of strict|json|text; falling back to strict",
                self.mode,
            )
            self.mode = "strict"

        # A local endpoint on loopback needs no credential. Requiring one would
        # push operators toward putting a placeholder secret in .env, which is
        # exactly the habit this project is trying to break.
        self._local = self.base_url.startswith(("http://127.0.0.1", "http://localhost", "http://0.0.0.0"))

        self.caps = PlanCapabilities(
            name="openai-compatible",
            schema_enforcement=_ENFORCEMENT[self.mode],  # type: ignore[arg-type]
            vision=True,
            # Declared by the operator, not inferred: only the account owner
            # knows whether their tier excludes training. Defaulting this to
            # True would be a privacy claim we cannot verify.
            zdr_eligible=_env("VEIL_LLM_ZDR", "").lower() in ("1", "true", "yes"),
            max_image_bytes=int(_env("VEIL_LLM_MAX_IMAGE_BYTES", "0") or 0),
            # Set by measurement, not by hope. bench/measure_grounding.py
            # writes this; the default is False because an unmeasured model has
            # not earned the claim.
            grounded_marks=_env("VEIL_LLM_GROUNDED_MARKS", "").lower() in ("1", "true", "yes"),
            usd_per_mtok_in=_env_float("VEIL_LLM_PRICING_IN"),
            usd_per_mtok_out=_env_float("VEIL_LLM_PRICING_OUT"),
            notes=(
                f"mode={self.mode}; "
                + ("no API key (local endpoint)" if not self.api_key and self._local else "authenticated")
            ),
        )

        self.available: bool | None = None
        self.engine_summary: str = "unprobed"
        self._client: httpx.AsyncClient | None = None

    # ------------------------------------------------------------- plumbing

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            headers = {"content-type": "application/json"}
            if self.api_key:
                headers["authorization"] = f"Bearer {self.api_key}"
            timeout = float(_env("VEIL_LLM_TIMEOUT_S", "90") or 90)
            self._client = httpx.AsyncClient(timeout=timeout, headers=headers)
        return self._client

    def model_name(self) -> str:
        return self.model

    async def probe(self) -> bool:
        try:
            c = await self._http()
            r = await c.get(f"{self.base_url}/models", timeout=8.0)
            if r.status_code == 200:
                data = r.json()
                names = [m.get("id") for m in data.get("data", []) if m.get("id")]
                self.available = True
                self.engine_summary = (
                    f"{self.model} at {self.base_url} "
                    f"({len(names)} model(s) listed; schema={self.caps.schema_enforcement})"
                )
            elif r.status_code in (401, 403):
                # Reachable but not authorised. That is a CONFIG error, not an
                # outage, and saying "unavailable" would send the operator
                # hunting in the wrong place.
                self.available = False
                self.engine_summary = (
                    f"endpoint reachable but rejected the credential ({r.status_code}). "
                    "Check VEIL_LLM_API_KEY."
                )
            else:
                self.available = False
                self.engine_summary = f"endpoint returned {r.status_code} on /models"
        except httpx.HTTPError as e:
            self.available = False
            self.engine_summary = f"endpoint unreachable ({type(e).__name__})"
        return bool(self.available)

    # -------------------------------------------------------------- payload

    def _messages(self, req: PlanRequest) -> list[dict[str, Any]]:
        content: list[dict[str, Any]] = [{"type": "text", "text": req.user_text}]
        if req.image_b64:
            if self.caps.max_image_bytes and req.image_bytes() > self.caps.max_image_bytes:
                raise ProviderUnavailable(
                    f"image is {req.image_bytes()} bytes, over this endpoint's "
                    f"{self.caps.max_image_bytes} limit"
                )
            content.append(
                {
                    "type": "image_url",
                    # detail=high matters: the default auto mode can downscale a
                    # screenshot to the point that small text and burnt-in mark
                    # numbers stop being legible, which is the whole input.
                    "image_url": {
                        "url": f"data:image/webp;base64,{req.image_b64}",
                        "detail": "high",
                    },
                }
            )
        return [
            {"role": "system", "content": req.system},
            {"role": "user", "content": content},
        ]

    def _payload(self, req: PlanRequest, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self._messages(req),
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "stream": stream,
        }
        if self.mode == "strict":
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "action_plan",
                    "strict": True,
                    "schema": ACTION_PLAN_JSON_SCHEMA,
                },
            }
        elif self.mode == "json":
            payload["response_format"] = {"type": "json_object"}
        if stream:
            # Ask for usage so cost can be accounted. Providers that do not
            # support it ignore the field; it is not required.
            payload["stream_options"] = {"include_usage": True}
        return payload

    # ------------------------------------------------------------ streaming

    async def stream(self, req: PlanRequest) -> AsyncIterator[str]:
        if self.available is None:
            await self.probe()
        if not self.available:
            raise ProviderUnavailable(self.engine_summary)

        c = await self._http()
        try:
            async with c.stream(
                "POST", f"{self.base_url}/chat/completions", json=self._payload(req, True)
            ) as r:
                if r.status_code == 401:
                    raise ProviderUnavailable(f"401 unauthorised — check VEIL_LLM_API_KEY")
                if r.status_code == 404:
                    raise ProviderUnavailable(
                        f"404 on /chat/completions at {self.base_url} — check VEIL_LLM_BASE_URL "
                        "(it must include the /v1 suffix)"
                    )
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", "replace")[:400]
                    raise ProviderUnavailable(f"endpoint {r.status_code}: {body}")

                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        return
                    if not data:
                        continue
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    for ch in obj.get("choices", []):
                        delta = ch.get("delta") or {}
                        # A refusal is signalled in-band by some providers and
                        # as a finish_reason by others.
                        if ch.get("finish_reason") == "content_filter":
                            raise ProviderUnavailable("provider refused (content_filter)")
                        piece = delta.get("content")
                        if piece:
                            yield piece
        except httpx.HTTPError as e:
            raise ProviderUnavailable(f"{type(e).__name__}: {e}") from e

    async def complete(self, req: PlanRequest) -> PlanResult:
        """Non-streaming path, used by the cost and grounding benchmarks.

        Streaming is the production path because it halves time-to-first-action.
        This exists so a benchmark can measure the same call without a consumer
        attached, and so token usage is always available.
        """
        if self.available is None:
            await self.probe()
        if not self.available:
            raise ProviderUnavailable(self.engine_summary)

        c = await self._http()
        t0 = time.perf_counter()
        try:
            r = await c.post(f"{self.base_url}/chat/completions", json=self._payload(req, False))
        except httpx.HTTPError as e:
            raise ProviderUnavailable(f"{type(e).__name__}: {e}") from e

        elapsed = (time.perf_counter() - t0) * 1000
        if r.status_code != 200:
            raise ProviderUnavailable(f"endpoint {r.status_code}: {r.text[:300]}")

        body = r.json()
        usage = body.get("usage") or {}
        choices = body.get("choices") or []
        text = ""
        refused = False
        for ch in choices:
            msg = ch.get("message") or {}
            text += msg.get("content") or ""
            if ch.get("finish_reason") == "content_filter" or msg.get("refusal"):
                refused = True
        return PlanResult(
            text=text,
            input_tokens=int(usage.get("prompt_tokens") or 0),
            output_tokens=int(usage.get("completion_tokens") or 0),
            refused=refused,
            refusal_reason="provider content filter" if refused else "",
            provider=self.caps.name,
            model=self.model,
            total_ms=elapsed,
        )
