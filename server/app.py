"""Veil server — ARCHITECTURE.md §9.

Deliberately thin. The client owns the privacy work; the server's only real
responsibilities are:

  1. Receive three ALIGNED artifacts (screen_state, redacted frame, manifest)
  2. Constrain the VLM to emit a schema-valid ActionPlan at the token level
  3. Stream it over SSE so the client can execute each action as it closes
  4. NEVER log a payload — only hashes and byte counts

The redaction manifest is treated as a contract, not a suggestion: the system
preamble is rebuilt from it every turn, and the plan is validated against the
same Zod contract the client uses.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import time
from pathlib import Path
from dataclasses import dataclass
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

# Sibling modules are imported as `from actions import ...`, which only resolves
# when the CWD is server/. That worked for the test suite (it chdir's) and broke
# every documented invocation — `uvicorn server.app:app` from the repo root
# failed with ModuleNotFoundError, and so would the Dockerfile's WORKDIR guess.
#
# Prefer the package-relative import; fall back to the flat one so running from
# inside server/ keeps working.
# A broad `except ImportError` here is a trap: the relative import can fail for
# a reason that has nothing to do with the import style (a missing dependency
# inside actions.py, say), and the fallback then reports a confusing
# ModuleNotFoundError for a module that plainly exists. So the fallback is
# guarded on the symptom, and the original error is printed.
try:
    from .actions import ActionPlan, validate_plan
    from .prompts import build_system_preamble
    from .vllm_client import VLLMClient, VLLMUnavailable
except ImportError as _rel_err:  # running as a script, not as `server.app`
    # Guard on the symptom. A broad except here hid a real failure: the
    # relative import raised for `vllm_client` from inside prompts.py, the
    # fallback ran, and the resulting error named a module that plainly existed.
    if getattr(_rel_err, "name", None) not in {
        "actions", "prompts", "vllm_client", "server",
    }:
        raise
    # The fallback only resolves if server/ itself is importable, which it is
    # not when the CWD is the repo root — so put it on the path explicitly
    # rather than depending on how uvicorn was invoked.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from actions import ActionPlan, validate_plan
    from prompts import build_system_preamble
    from vllm_client import VLLMClient, VLLMUnavailable

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

log = logging.getLogger("veil")

SCHEMA_VERSION = "1.0.0"
app = FastAPI(title="Veil", version="0.1.0")

# The extension is a browser origin, not a server-side caller.
#
# CORS here is a real control, not a formality: the extension holds a
# capability that a web page does not — a redaction manifest, and a server that
# will act on a screen. With `allow_origins=["*"]` (which docker-compose was
# setting) ANY website in the user's browser could POST to this server and get
# a plan back. So the default is deny-by-default: an explicit list, and a
# wildcard is refused outright rather than honoured.
#
# The extension id is stable for a locally-loaded unpacked build, so
# chrome-extension://<id> is the real value to configure. A dev convenience
# remains: set VEIL_ALLOWED_ORIGINS=dev to allow any extension origin, which is
# still narrower than "*" because it excludes http/https pages.
_RAW_ORIGINS = os.environ.get("VEIL_ALLOWED_ORIGINS", "").strip()

if _RAW_ORIGINS.lower() in {"*", "null", ""}:
    if _RAW_ORIGINS == "":
        _ALLOWED = []
    else:
        # An explicit "*" is a configuration mistake, not an intent. Refusing it
        # means the failure mode is "the extension cannot connect" rather than
        # "every site on the internet can drive this server".
        log.error(
            "VEIL_ALLOWED_ORIGINS=%r is not a valid origin list. Refusing to "
            "start with a wildcard. Set comma-separated origins, or 'dev' to "
            "allow any extension origin during development.",
            _RAW_ORIGINS,
        )
        raise SystemExit(2)
elif _RAW_ORIGINS.lower() == "dev":
    _ALLOWED = [
        "chrome-extension://*",
        "moz-extension://*",
    ]
else:
    _ALLOWED = [o.strip() for o in _RAW_ORIGINS.split(",") if o.strip()]

if not _ALLOWED:
    log.warning(
        "No CORS origins configured: the API will accept same-origin and "
        "non-browser callers only. A browser extension must be added to "
        "VEIL_ALLOWED_ORIGINS (e.g. chrome-extension://abcdef...)."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
    # No cookies, no credentials: nothing here is session-authenticated, and
    # allowing credentials with a broad origin list is how a token leaks.
    allow_credentials=False,
)

client = VLLMClient()


# ---------------------------------------------------------------- models


class BoxModel(BaseModel):
    x: float
    y: float
    w: float = Field(ge=0)
    h: float = Field(ge=0)


class RedactionModel(BaseModel):
    id: str
    box: BoxModel
    cls: str
    placeholder: dict[str, str]
    method: str
    score: float = Field(ge=0, le=1)
    source: str

    # The CLIENT sends `pixelDerived` (camelCase — see RedactionEntrySchema in
    # extension/lib/schema.ts). This field was `pixel_derived`, so every real
    # manifest from the extension failed validation with 422 and the server
    # tests never caught it because their fixtures were written in the server's
    # own spelling. The client is the source of truth for the wire format.
    pixelDerived: bool = Field(alias="pixelDerived")

    model_config = ConfigDict(populate_by_name=True)


class ManifestModel(BaseModel):
    schema_version: str
    session_id: str = Field(min_length=8)
    redactions: list[RedactionModel]
    frame_hash: str
    # Integrity digest, not an authentication token. See redact.ts:signManifest.
    signature: str
    model_versions: dict[str, str]
    abort_reason: str | None = None


class NodeModel(BaseModel):
    id: str
    role: str
    label: str | None = None
    valueType: str | None = None  # noqa: N815 — wire contract
    valueClass: str  # noqa: N815
    bbox: BoxModel | None = None
    mark: int | None = None
    actions: list[str] = []
    children: list["NodeModel"] = []


class ScreenStateModel(BaseModel):
    schema_version: str
    session_id: str
    frame_hash: str
    url: str
    title: str
    root: NodeModel
    mark_count: int = Field(ge=0)


class TileModel(BaseModel):
    x: int
    y: int
    w: int = Field(gt=0)
    h: int = Field(gt=0)
    b64: str
    """The redacted pixels for this tile, as a base64 image.

    Required, not optional: coordinates alone cannot re-composite anything. The
    client crops each dirty tile out of the ALREADY-REDACTED frame, so the tile
    that travels is redacted tile data — the byte savings come from not
    re-sending unchanged regions, never from sending raw pixels.
    """


class StepRequest(BaseModel):
    schema_version: str = SCHEMA_VERSION
    session_id: str = Field(min_length=8)
    intent: str = Field(max_length=2000)
    turn: int = Field(default=0, ge=0)
    screen_state: ScreenStateModel
    redaction_manifest: ManifestModel
    image_b64: str | None = None
    tiles: list[TileModel] | None = None
    client_timings: dict[str, float] = {}
    tier: str = "T1"


NodeModel.model_rebuild()


# ---------------------------------------------------------------- helpers


def _log_metadata(req: StepRequest, out: str, elapsed_ms: float) -> None:
    """Log hashes and byte counts ONLY. Never a payload. §9."""
    prompt_hash = hashlib.sha256(req.intent.encode()).hexdigest()[:12]
    frame_hash = req.redaction_manifest.frame_hash[:12]
    log.info(
        "session=%s turn=%d tier=%s redactions=%d frame=%s prompt=%s "
        "bytes_out=%d bytes_in=%d elapsed_ms=%.0f",
        req.session_id[-8:],
        req.turn,
        req.tier,
        len(req.redaction_manifest.redactions),
        frame_hash,
        prompt_hash,
        len(req.image_b64 or ""),
        len(out),
        elapsed_ms,
    )


# ---------------------------------------------------------------- routes


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "vllm": client.available,
        "model": client.model_name,
        "engine": client.engine_summary,
    }


@app.post("/v1/agent/step")
async def step(req: StepRequest, request: Request) -> StreamingResponse:
    """SSE stream of the ActionPlan.

    XGrammar guarantees a schema-valid prefix, so the client can execute each
    action object the moment its closing brace arrives — first-action latency
    is a fraction of full-plan latency. §8.3
    """
    if req.redaction_manifest.abort_reason:
        # Fail closed at the server too. A client that reports an abort must
        # never receive a plan.
        raise HTTPException(status_code=409, detail=f"client gate aborted: {req.redaction_manifest.abort_reason}")

    if req.turn > 0 and not req.image_b64 and not req.tiles:
        raise HTTPException(status_code=400, detail="delta turn requires image_b64 or tiles")

    # §7 delta-tile re-compositing, on the STEP path.
    #
    # The endpoint used to merely CHECK that tiles were present and then plan
    # against `image_b64` — which is None on a tiled turn. So a client that
    # correctly shipped only dirty tiles got a plan generated with no image at
    # all, and nothing told it so. The tiles are now merged onto the session's
    # cached base frame first, and the merged frame is what the VLM sees.
    effective_image = req.image_b64
    if req.tiles and not req.image_b64:
        base = client.last_frame(req.session_id)
        if base is None:
            # No base to composite onto. Answerable, but the client must know:
            # a 409 here is what makes it re-send a full frame.
            raise HTTPException(
                status_code=409,
                detail="delta turn has no base frame for this session; send a full frame",
            )
        # recomposite() takes and returns base64; it decodes internally.
        effective_image = client.recomposite(base, [t.model_dump() for t in req.tiles])
        client.store_frame(req.session_id, effective_image)
    elif req.image_b64:
        # A full frame becomes the new base for subsequent delta turns.
        client.store_frame(req.session_id, req.image_b64)

    preamble = build_system_preamble(req.redaction_manifest.model_dump())
    user_text = _build_user_text(req)

    async def gen() -> AsyncIterator[str]:
        t0 = time.perf_counter()
        acc: list[str] = []
        try:
            async for chunk in client.stream_plan(preamble, user_text, effective_image):
                acc.append(chunk)
                yield f"data: {json.dumps({'delta': chunk})}\n\n"
        except VLLMUnavailable as e:
            # Honest degradation, never a hallucinated plan. §9
            fallback = ActionPlan(
                schema_version=SCHEMA_VERSION,
                session_id=req.session_id,
                steps=[{"action": "none", "reason": "reasoning engine unavailable"}],
                confidence=0.0,
                needs_more_context=[str(e)],
            )
            body = fallback.model_dump_json()
            yield f"data: {json.dumps({'delta': body})}\n\n"
            _log_metadata(req, body, (time.perf_counter() - t0) * 1000)
            yield "data: [DONE]\n\n"
            return

        _log_metadata(req, "".join(acc), (time.perf_counter() - t0) * 1000)
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/agent/tiles")
async def tiles(req: StepRequest) -> dict[str, Any]:
    """Delta-tile re-compositing against the last full frame for this session.

    The client already computed which tiles changed; we re-composite them onto
    the cached base so the VLM sees a coherent frame without re-uploading it. §7
    """
    if not req.tiles:
        raise HTTPException(status_code=400, detail="no tiles supplied")

    base = client.last_frame(req.session_id)
    if base is None:
        # No base frame cached: the client must send a full frame instead.
        raise HTTPException(status_code=409, detail="no base frame for session; send a full frame")

    merged = client.recomposite(base, [t.model_dump() for t in req.tiles])
    client.store_frame(req.session_id, merged)

    return {
        "ok": True,
        "session_id": req.session_id,
        "frame_hash": client.last_frame_hash(req.session_id),
        "bytes": len(merged),
        "tiles_applied": len(req.tiles),
    }


@app.post("/v1/agent/validate")
async def validate(req: dict[str, Any]) -> dict[str, Any]:
    """Validate a plan against the same contract the client enforces."""
    try:
        plan = validate_plan(req.get("plan", req))
    except Exception as e:  # noqa: BLE001 — surfaced verbatim to the client
        return {"ok": False, "error": str(e)}
    return {"ok": True, "plan": plan.model_dump()}


def _build_user_text(req: StepRequest) -> str:
    """Compact the pruned tree into something a VLM can read cheaply.

    Target is a few hundred tokens for a typical page (§4). We render the
    MARK:role:label lines rather than a JSON blob — the model needs the marks,
    not the schema.
    """
    lines: list[str] = []
    lines.append(f"PAGE: {req.screen_state.title}")
    lines.append(f"URL: {req.screen_state.url}")
    lines.append(f"MARKS: {req.screen_state.mark_count}")
    lines.append("")

    def walk(n: NodeModel, depth: int = 0) -> None:
        if depth > 6:
            return
        parts: list[str] = []
        if n.mark is not None:
            parts.append(f"[{n.mark}]")
        parts.append(n.role)
        if n.label:
            parts.append(f'"{n.label[:80]}"')
        if n.valueClass == "sensitive":
            # The value itself is already a placeholder; say so and move on.
            parts.append("(hidden)")
        if n.actions:
            parts.append(f"<{','.join(n.actions[:3])}>")
        line = "  " * depth + " ".join(parts)
        if len(parts) > 1 or n.children:
            lines.append(line)
        for c in n.children[:12]:
            walk(c, depth + 1)

    walk(req.screen_state.root)
    lines.append("")
    lines.append(f"USER WANTS: {req.intent}")
    return "\n".join(lines)
