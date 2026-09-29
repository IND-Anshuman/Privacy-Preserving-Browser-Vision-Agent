# syntax=docker/dockerfile:1
# Veil server + vLLM V1. One command reproduces the SIH cloud behaviour offline. §9
#
# Stage 1: the reasoning engine, configured for THIS workload, not for chat.
ARG VLLM_IMAGE=vllm/vllm-openai:latest

# --- Stage 1: vLLM with prefix caching + XGrammar + ngram speculation ------
FROM ${VLLM_IMAGE} AS engine

# Weights are mounted or pulled at first start; the image stays generic so a
# judge can swap the model without rebuilding.
ENV VLLM_WORKER_MULTIPROC_METHOD=spawn \
    VLLM_LOGGING_LEVEL=INFO

# The serve command lives in compose so the flags are visible and editable
# without rebuilding this image.

# --- Stage 2: the thin FastAPI layer ---------------------------------------
FROM python:3.11-slim AS app

WORKDIR /srv

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ ./server/
COPY bench/ /srv/bench/

ENV PYTHONUNBUFFERED=1 \
    VLLM_BASE_URL=http://vllm:8001 \
    VEIL_LLM_TIMEOUT_S=90

# CORS is NOT set here, and that is deliberate.
#
# This used to bake in `VEIL_ALLOWED_ORIGINS=chrome-extension://*`, which the
# server now REFUSES outright — a wildcard raises SystemExit(2) at import, so
# the container could not start at all. It went unnoticed because every local
# test runs the app in-process and never builds the image.
#
# Leaving it unset is also the safer default: with no origins configured the
# server accepts same-origin and non-browser callers only, and a browser
# extension is refused until an operator states which extension is allowed.
# Supply a real value at run time, e.g.
#   -e VEIL_ALLOWED_ORIGINS=chrome-extension://<extension-id>
# or `dev` to accept any well-formed extension origin during development.

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000"]
