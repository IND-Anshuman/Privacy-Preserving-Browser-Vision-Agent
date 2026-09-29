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
    from .actions import ActionPlan, check_plan_against_state, validate_plan
    from .prompts import build_system_preamble
    from .providers import PlanRequest, ProviderUnavailable, Router
    from .session import DEFAULT_MAX_ATTEMPTS, SessionStore
    from .injection import injection_note, scan_many
    from . import manifest_privacy
    # Retained for the delta-tile frame cache, which is transport state, not
    # model state, and has no business moving behind the provider interface.
    from .vllm_client import VLLMClient, VLLMUnavailable
except ImportError as _rel_err:  # running as a script, not as `server.app`
    # Guard on the symptom. A broad except here hid a real failure: the
    # relative import raised for `vllm_client` from inside prompts.py, the
    # fallback ran, and the resulting error named a module that plainly existed.
    if getattr(_rel_err, "name", None) not in {
        "actions", "prompts", "vllm_client", "server", "providers",
        "session", "injection", "manifest_privacy",
    }:
        raise
    # The fallback only resolves if server/ itself is importable, which it is
    # not when the CWD is the repo root — so put it on the path explicitly
    # rather than depending on how uvicorn was invoked.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from actions import ActionPlan, validate_plan
    from prompts import build_system_preamble
    from providers import PlanRequest, ProviderUnavailable, Router
    from session import DEFAULT_MAX_ATTEMPTS, SessionStore
    from injection import injection_note, scan_many
    from vllm_client import VLLMClient, VLLMUnavailable
    import manifest_privacy

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
        _ALLOWED: list[Any] = []
        # Must be defined on EVERY branch. The empty-origin path returns before
        # the dev/else branches assign it, and a later `if not _ALLOWED and not
        # _ALLOWED_REGEX` then raises NameError at import — so a server with no
        # origins configured would fail to start at all.
        _ALLOWED_REGEX: str | None = None
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
    # A CORS regex must go in `allow_origin_regex`, NOT in `allow_origins`.
    #
    # This went wrong twice before this line was correct. First: the value was
    # `["chrome-extension://*"]`, a glob, and Starlette compares allow_origins by
    # exact string equality with no wildcard support — so it matched NOTHING and
    # the extension was fully blocked while /health looked healthy. Second: a
    # compiled `re.Pattern` placed in `allow_origins` fails the same way, since
    # a Pattern never == a string. `allow_origin_regex` is the parameter that
    # actually does pattern matching.
    #
    # The security property is preserved exactly: a web page origin
    # (https://…) cannot satisfy either pattern, so `dev` remains narrower than
    # "*" and still excludes every http/https page.
    _ALLOWED_REGEX: str | None = (
        r"^(?:chrome-extension://[a-z]{32}"
        r"|moz-extension://[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
        r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"
    )
    _ALLOWED = []
    log.info(
        "VEIL_ALLOWED_ORIGINS=dev — allowing chrome-extension and moz-extension "
        "origins of the correct shape. Web pages (http/https origins) are "
        "still refused."
    )
else:
    _ALLOWED = [o.strip() for o in _RAW_ORIGINS.split(",") if o.strip()]
    _ALLOWED_REGEX = None

if not _ALLOWED and not _ALLOWED_REGEX:
    log.warning(
        "No CORS origins configured: the API will accept same-origin and "
        "non-browser callers only. A browser extension must be added to "
        "VEIL_ALLOWED_ORIGINS (e.g. chrome-extension://abcdef...)."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED,
    # Pattern matching happens HERE, not in allow_origins. Passing a compiled
    # Pattern in allow_origins looks reasonable and matches nothing, because
    # Starlette compares that list by exact string equality.
    allow_origin_regex=_ALLOWED_REGEX,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
    # No cookies, no credentials: nothing here is session-authenticated, and
    # allowing credentials with a broad origin list is how a token leaks.
    allow_credentials=False,
)

# The planner (any OpenAI-compatible vision endpoint, or a local vLLM) and the
# per-session state. Both are module-level singletons because FastAPI handlers
# are stateless functions; the state they share is transport state, not
# request state, and lives in the objects rather than in globals.
# Load .env BEFORE the singletons below.
#
# Each provider snapshots os.environ into self.base_url / self.api_key /
# self.model in its __init__, so configuration is read exactly once, at import
# time. `uvicorn --env-file .env` populates the environment AFTER this module
# is imported, which meant every provider captured an empty base_url and no key
# and fell back to http://127.0.0.1:8001. With nothing there, /health reported
# "no provider reachable" and every step returned action:none — permanently,
# no matter how correct the .env was. The documented start command could not
# work, and looked configured while behaving unconfigured, which is the worst
# way for this to fail.
#
# `setdefault` keeps an explicitly-exported variable winning, so a test harness
# that sets VEIL_* in os.environ is not overridden by the file.
def _load_env_file() -> None:
    try:
        from dotenv import load_dotenv  # optional dependency
    except ImportError:
        path = os.environ.get("VEIL_ENV_FILE", str(Path(__file__).resolve().parents[1] / ".env"))
        if not os.path.isfile(path):
            return
        try:
            for raw in Path(path).read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))
        except OSError as e:  # unreadable .env must not kill the import
            log.warning("could not read %s: %s", path, e)
        return
    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)


_load_env_file()

router = Router()
sessions = SessionStore()
client = VLLMClient()

#: Below this plan confidence the client is told to ask rather than act. The
#: model emits `confidence` and nothing consumed it; this is the consumer, and
#: the threshold is deliberately conservative — an unnecessary question is a
#: much smaller failure than a wrong click.
CONFIDENCE_FLOOR = float(os.environ.get("VEIL_CONFIDENCE_FLOOR", "0.55"))


def _page_texts(req: StepRequest) -> list[str]:
    """Every label the client sent, for injection scanning.

    Deliberately labels only, never values. A password's "label" is its field
    name; scanning it costs nothing and the raw value never reaches here.
    """
    out: list[str] = []
    stack = [req.screen_state.root]
    while stack:
        n = stack.pop()
        if n.label:
            out.append(n.label)
        stack.extend(n.children)
    return out


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


@app.get("/live")
async def live() -> dict[str, object]:
    """Liveness only. Deliberately does NOT resolve a provider.

    The panel needs to answer two different questions:

      "is the server running?"        -> this endpoint, sub-millisecond
      "which provider can it reach?"  -> /health, which probes the remote
                                         endpoint and measured p50 2.91s /
                                         max 4.79s against a real provider

    The panel was calling /health to display the first, with a 4000ms timeout.
    That sits inside the measured distribution, so a perfectly healthy server
    was reported as "unreachable (timeout)" often enough to look like a fault —
    and it pointed the user at restarting a server that did not need it.

    This endpoint resolves nothing and touches no provider, so it is fast
    enough to be a status line. It also deliberately exposes no configuration,
    so it is safe to call before anything is set up.
    """
    return {"ok": True, "service": "veil"}


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness plus the honesty surface.

    Reports every configured provider with its DECLARED capabilities, plus what
    is actually selected right now. An operator debugging "why is my plan being
    rejected" needs to see that the provider downgraded its schema enforcement,
    and a health check that only says `ok: true` would hide exactly that.

    `/health` used to call `router.active()`, which only reports whichever
    provider a PREVIOUS request happened to select. On a freshly started server
    nothing has been resolved yet, so it always answered "no provider reachable"
    and `model: null` — even with a perfectly configured endpoint. The symptom
    is indistinguishable from a misconfiguration, which sends the operator
    hunting through their .env for a mistake that was never there.

    So it resolves now. The probes are cheap HTTP GETs to /models and the result
    is cached inside each provider, so a poll loop is not hammering the endpoint.
    """
    active = await router.resolve()
    caps = [p.caps.as_dict() for p in router.providers]
    # `engine_summary` is a convention, not part of the provider contract:
    # LocalVLLMProvider and OpenAICompatProvider both define it, FakeProvider
    # does not. Reading it as `active.engine_summary` made /health raise
    # AttributeError — a 500 on the one endpoint an operator and a container
    # orchestrator both poll. A missing summary must degrade the report, never
    # break it.
    summary = (
        getattr(active, "engine_summary", None)
        or (f"{active.caps.name} (no engine summary)" if active else "no provider reachable")
    )
    return {
        "ok": True,
        "vllm": client.available,
        "model": active.model_name() if active else None,
        "engine": summary,
        "provider": active.caps.name if active else None,
        "providers": caps,
        "confidence_floor": CONFIDENCE_FLOOR,
        "manifest_privacy": manifest_privacy.mode_from_env(),
        "sessions": len(sessions.all()),
    }


@app.get("/v1/agent/session/{session_id}")
async def session_status(session_id: str) -> dict[str, Any]:
    """Per-session cost, attempts and failures. Read-only.

    Exists so the extension's HUD can show what a task has cost and why it is
    stuck, instead of the user guessing. Deliberately not a payload endpoint:
    it returns counts and state, never a plan or a page.
    """
    s = sessions.get(session_id)
    return {
        # The full id, not a suffix. A truncated id makes the endpoint
        # impossible to correlate with a plan, which is the one thing it
        # exists for. It is an opaque client-generated string, not a secret.
        "session_id": session_id,
        "intent": s.intent[:200],
        **s.summary(),
        "recent_failures": s.failures[-3:],
        "declined": s.declined[-3:],
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

    # ---- session state, and the loop cap -------------------------------
    #
    # The cap is checked BEFORE planning, not after. A step that fails, replans,
    # fails again is an agent that will spin; the property that makes retrying
    # safe is that it cannot.
    sess = sessions.get(req.session_id)
    if req.intent:
        sess.intent = req.intent
    sess.turns += 1
    if sess.exhausted():
        stop = ActionPlan(
            schema_version=SCHEMA_VERSION,
            session_id=req.session_id,
            steps=[
                {
                    "action": "ask_user",
                    "reason": (
                        f"stopping after {len(sess.attempts)} attempts without "
                        f"success: {sess.failures[-1][:120] if sess.failures else 'unknown'}. "
                        "Handing control back rather than retrying."
                    ),
                }
            ],
            confidence=0.0,
            needs_more_context=["manual intervention required"],
        )
        log.info(
            "session=%s replan cap reached (%d attempts)", req.session_id[-8:], len(sess.attempts)
        )
        return StreamingResponse(
            _sse_once(stop.model_dump_json()),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    # ---- injection scan -----------------------------------------------
    findings = scan_many(_page_texts(req))
    if findings:
        log.warning(
            "session=%s page contains instruction-shaped text: %s",
            req.session_id[-8:],
            ",".join(sorted({f.kind for f in findings})),
        )

    # ---- provider ------------------------------------------------------
    provider = await router.resolve()
    if provider is None:
        return StreamingResponse(
            _sse_once(
                ActionPlan(
                    schema_version=SCHEMA_VERSION,
                    session_id=req.session_id,
                    steps=[{"action": "none", "reason": "no provider reachable"}],
                    confidence=0.0,
                    needs_more_context=["configure VEIL_LLM_API_KEY / VEIL_LLM_BASE_URL / VEIL_LLM_MODEL"],
                ).model_dump_json()
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

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

    preamble = build_system_preamble(
        req.redaction_manifest.model_dump(),
        session=sess,
        capabilities=provider.caps,
        injection=injection_note(findings),
    )
    user_text = _build_user_text(req)
    plan_req = PlanRequest(
        system=preamble,
        user_text=user_text,
        image_b64=effective_image,
        session_id=req.session_id,
        turn=req.turn,
        # The schema allows 12 steps. At ~100 tokens per step with a reason
        # string, 512 truncates a long plan mid-JSON — which arrives at the
        # client as an unparseable plan rather than as a short one. Measured
        # against a 30B vision model; see bench/measure_grounding.py.
        max_tokens=int(os.environ.get("VEIL_LLM_MAX_TOKENS", "1536")),
    )

    async def gen() -> AsyncIterator[str]:
        t0 = time.perf_counter()
        acc: list[str] = []
        first = True
        try:
            async for chunk in provider.stream(plan_req):
                acc.append(chunk)
                yield f"data: {json.dumps({'delta': chunk})}\n\n"
                if first:
                    first = False
                    _first_token_ms = (time.perf_counter() - t0) * 1000
        except ProviderUnavailable as e:
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

        raw = "".join(acc)
        gated = _apply_escalation_gate(raw, req, sess)
        if gated is not None:
            # The plan was schema-valid but not trustworthy enough to execute.
            # Re-stream the replacement so the client executes nothing else.
            acc = [gated]
            raw = gated
            yield f"data: {json.dumps({'delta': gated})}\n\n"

        # Cost accounting. Estimated from the request when the streaming path
        # does not report usage: an image is ~1.1-1.6k tokens at 1080p, and the
        # tree is a few hundred. Marked as an estimate because it is one — a
        # billing figure invented from a formula is worse than no figure.
        est_in = plan_req.image_bytes() // 750 + len(preamble) // 4 + len(user_text) // 4
        sess.record_cost(est_in, max(0, len(raw) // 4), est_in / 1_000_000 * (provider.caps.usd_per_mtok_in or 0.0))
        log.info(
            "session=%s provider=%s model=%s est_in_tok=%d cost_usd=%s cumulative=%s",
            req.session_id[-8:],
            provider.caps.name,
            provider.model_name(),
            est_in,
            sess.cost_usd if sess.cost_usd is not None else "unknown",
            sess.cost_usd if sess.cost_usd is not None else "unknown",
        )

        _log_metadata(req, raw, (time.perf_counter() - t0) * 1000)
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


@app.post("/v1/agent/outcome")
async def outcome(body: dict[str, Any]) -> dict[str, Any]:
    """Client reports what actually happened after executing a step.

    This is the input the replan loop needs. Without it the server cannot tell
    "the step worked" from "the step silently did nothing", and a failed
    automation looks exactly like a successful one until the user notices.

    Accepts only counts, action names and a short reason. A free-form `detail`
    is truncated and never treated as instructions.
    """
    sid = str(body.get("session_id", ""))
    if len(sid) < 8:
        raise HTTPException(status_code=400, detail="session_id required")
    s = sessions.get(sid)

    action = str(body.get("action", ""))[:32]
    ok = bool(body.get("ok", False))
    detail = str(body.get("detail", ""))[:200]

    if ok:
        if action:
            s.completed.append(action)
    else:
        if detail:
            s.failures.append(detail)
        s.note_attempt(int(body.get("turn", s.turns)), action or "unknown", ok=False, detail=detail)

    declined = body.get("declined")
    if declined:
        # Remembered so the next preamble can say "the user declined this" and
        # the model does not propose it again. The anti-nagging property.
        s.declined.append(str(declined)[:80])

    return {"ok": True, **s.summary()}


@app.post("/v1/agent/validate")
async def validate(req: dict[str, Any]) -> dict[str, Any]:
    """Validate a plan against the same contract the client enforces."""
    try:
        plan = validate_plan(req.get("plan", req))
    except Exception as e:  # noqa: BLE001 — surfaced verbatim to the client
        return {"ok": False, "error": str(e)}
    return {"ok": True, "plan": plan.model_dump()}


async def _sse_once(plan_json: str) -> AsyncIterator[str]:
    """A complete plan as a one-chunk SSE stream, then [DONE].

    Used for the paths that must NOT call a model at all — the loop cap and the
    no-provider case. They still have to arrive in the same envelope the client
    already parses, because a client that special-cases them is a client with
    two code paths to keep in sync.
    """
    yield f"data: {json.dumps({'delta': plan_json})}\n\n"
    yield "data: [DONE]\n\n"


def _apply_escalation_gate(
    raw: str, req: StepRequest, sess: Any
) -> str | None:
    """Replace an executable-but-untrustworthy plan with an ask_user.

    Returns the replacement JSON, or None to let the plan through. Two triggers:

      LOW CONFIDENCE — the model emitted `confidence` and nothing consumed it.
        A plan below the floor is turned into a question. An unnecessary
        question is a much smaller failure than a wrong click.

      LOOP CAP — checked before planning for new attempts, but a plan that
        arrives on the attempt that hits the cap is replaced here too, so the
        cap holds regardless of which path the turn took.

    A plan that will not parse is NOT touched here — UNLESS the reason it would
    not parse is a SAFETY rejection, which must never read as "carry on".
    """
    try:
        plan = ActionPlan.model_validate_json(raw)
    except Exception as e:  # noqa: BLE001
        # THE FAIL-OPEN THIS REPLACES
        # ---------------------------
        # This used to `return None` on any exception, because a truncated
        # JSON blob is not worth rewriting. But a ValidationError raised by the
        # DESTRUCTIVE-VERB check looks identical from here, and None means "no
        # replacement needed" to the caller. So the one plan that most needed a
        # human — the one the safety rule had just rejected — was the one plan
        # allowed straight through to the client.
        #
        # Measured against the live model: "pay for the order" came back as
        # action=click, confidence=0.98. It was correctly rejected, and that
        # rejection was swallowed.
        #
        # The two cases are distinguishable: a truncation has no usable message
        # about what was wrong, a safety rejection names the offending verb.
        # So a rejection we can explain becomes an ask_user, and only a truly
        # unparseable blob still passes through untouched — where the client's
        # own parser will reject it anyway.
        msg = str(e)
        if "destructive verb" in msg:
            log.warning("plan rejected by the destructive gate: %s", msg)
            # Recover the session id from the raw text rather than from `plan`,
            # which does not exist on this branch.
            import re as _re

            m = _re.search(r'"session_id"\s*:\s*"([^"]+)"', raw)
            return _ask_user_replacement(
                m.group(1) if m else "",
                f"this plan targets something destructive, so it needs you: {msg[:200]}",
            )
        return None

    reasons: list[str] = []
    if plan.confidence < CONFIDENCE_FLOOR:
        reasons.append(f"model confidence {plan.confidence:.2f} is below the {CONFIDENCE_FLOOR:.2f} floor")

    if sess.exhausted():
        reasons.append(f"reached the {DEFAULT_MAX_ATTEMPTS}-attempt cap for this task")

    # PLAN-vs-STATE. `check_plan_against_state` was written, unit-tested in
    # bench/test_server.py, and then never called from anywhere in the live
    # path — so a plan naming a mark that does not exist on this page, or
    # filling a sensitive field, sailed straight through to the extension. The
    # client re-resolves marks and refuses a lost one, but a plan that fills a
    # field the model mistook for a password field was never caught at all.
    #
    # This is the one place every plan passes through, so it is the right place
    # for the check. Failures become an ask_user rather than an exception: a
    # wrong-but-parseable plan should stop and ask, not 500.
    try:
        state_problems = check_plan_against_state(
            plan, req.screen_state.model_dump(mode="json")
        )
    except Exception as exc:  # noqa: BLE001 — never let the gate itself 500 a turn
        log.warning("plan-vs-state check failed to run: %s", exc)
        state_problems = []
    if state_problems:
        reasons.extend(state_problems)

    if not reasons:
        # `steps` holds typed ActionStep models, not dicts. Reaching for .get()
        # here raised AttributeError on the first plan that passed the gate,
        # which is to say on the first plan that was actually usable.
        first = plan.steps[0]
        first_action = getattr(first, "action", None) or "none"
        sess.note_attempt(req.turn, first_action, ok=True)
        return None

    escalated = ActionPlan(
        schema_version=SCHEMA_VERSION,
        session_id=req.session_id,
        steps=[{"action": "ask_user", "reason": "; ".join(reasons) + ". Confirm how to proceed."}],
        confidence=plan.confidence,
        needs_more_context=list(plan.needs_more_context) + reasons,
    )
    sess.note_attempt(req.turn, "ask_user", ok=False, detail="; ".join(reasons))
    log.info(
        "session=%s escalated to ask_user (%s)", req.session_id[-8:], "; ".join(reasons)
    )
    return escalated.model_dump_json()


def _ask_user_replacement(session_id: str, reason: str) -> str:
    """A plan that stops and asks, for a plan we refused to even parse.

    Separate from the escalation path above because that one needs a `plan` and
    a live `req` to read confidence and session state from. This branch has
    neither: the raw text failed validation, so the only honest thing to send
    is a question and no steps.

    Confidence is 0.0 because nothing was successfully understood — claiming
    the model's own number here would report confidence in a plan we discarded.
    """
    return ActionPlan(
        schema_version=SCHEMA_VERSION,
        session_id=session_id or "unknown-session",
        steps=[{"action": "ask_user", "reason": reason}],
        confidence=0.0,
        needs_more_context=["manual intervention required"],
    ).model_dump_json()


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
    # The session id MUST be in the prompt. It was missing, so a model could
    # not echo it, and the plan it returned carried whatever id it invented —
    # which the client then rejected as a cross-session plan. The schema
    # requires the field; the prompt has to supply the value.
    lines.append(f"SESSION: {req.session_id}")
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
