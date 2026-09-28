"""Mock OpenAI-compatible endpoint, so the grounding probe's OWN code path can
be verified without spending money or needing a key.

The probe is the project's highest-risk measurement — it is what decides
whether an API model is usable as a planner — so it needs to be trustworthy
before anyone trusts its output. Running it against a real endpoint the first
time it is ever executed would be exactly the mistake this project has spent the
week correcting.

    ./.venv/Scripts/python.exe bench/mock_llm_server.py

Then, in another shell:
    VEIL_LLM_BASE_URL=http://127.0.0.1:8099 \\
    VEIL_LLM_API_KEY=not-needed \\
    VEIL_LLM_MODEL=mock-vision \\
    ./.venv/Scripts/python.exe bench/measure_grounding.py

`--behaviour` selects the failure mode to rehearse:
    good      schema-valid plan that uses a real mark
    nomark    schema-valid plan that never targets anything
    invent    schema-valid plan that invents a mark that does not exist
    loose     JSON that violates the schema, to prove rejection is visible
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

BEHAVIOUR = "good"
CALLS: list[dict] = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a) -> None:  # keep the output readable
        pass

    def _send(self, obj: dict, status: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/").endswith("/models"):
            self._send({"object": "list", "data": [{"id": "mock-vision"}]})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(n) or b"{}")
        CALLS.append(payload)

        # The production path is STREAMING, so the mock must speak SSE. An
        # earlier version answered with a plain JSON body regardless, which made
        # `stream()` yield zero chunks and the server emitted `data: [DONE]`
        # with no plan — an empty response that looks like a hang.
        if payload.get("stream"):
            self._send_sse(self._plan_text(payload))
            return
        self._send({
            "choices": [{"message": {"content": plan_text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1900, "completion_tokens": 60},
        })

    def _send_sse(self, content: str) -> None:
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-store")
        self.end_headers()
        for i in range(0, len(content), 48):
            piece = content[i : i + 48]
            self.wfile.write(
                f"data: {json.dumps({'choices': [{'delta': {'content': piece}}]})}\n\n".encode()
            )
        self.wfile.write(
            f"data: {json.dumps({'choices': [], 'usage': {'prompt_tokens': 1900, 'completion_tokens': 60}})}\n\n".encode()
        )
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _plan_text(self, payload: dict) -> str:
        # Echo the session id the CALLER sent, not a fixed one. A fixed id meant
        # the e2e check "the plan carries the session id" failed for a reason
        # that had nothing to do with the server: the mock was answering a
        # different question than the one the test asked.
        sid = "mock-session"
        # The session id arrives in the request body (screen_state.session_id),
        # not in the system preamble, so scan the serialized payload for a
        # recognisable session prefix.
        blob = json.dumps(payload)
        for cand in ("e2e-session-", "dbg-", "bench-"):
            i = blob.find(cand)
            if i >= 0:
                tail = blob[i:]
                j = 0
                while j < len(tail) and (tail[j].isalnum() or tail[j] in "-_"):
                    j += 1
                sid = tail[:j]
                break

        # Find a mark that the prompt ACTUALLY offered. An earlier version took
        # the last "[N]" line it saw, which was not necessarily a mark the probe
        # considered valid — the probe checks invented marks against the set it
        # sent, so the mock must pick from that same set.
        real = None
        for chunk in payload.get("messages", []):
            c = chunk.get("content")
            if isinstance(c, list):
                for part in c:
                    if part.get("type") == "text":
                        for line in (part.get("text") or "").splitlines():
                            ls = line.strip()
                            if ls.startswith("[") and "]" in ls:
                                try:
                                    real = int(ls[1:].split("]")[0])
                                    break
                                except ValueError:
                                    continue
                            if real is not None:
                                break
                        if real is not None:
                            break
            if real is not None:
                break
        if real is None:
            real = 1

        if BEHAVIOUR == "nomark":
            steps = [{"action": "none", "reason": "mock: no target"}]
        elif BEHAVIOUR == "invent":
            steps = [{"action": "click", "target": {"mark": 9999}}]
        elif BEHAVIOUR == "loose":
            # Deliberately schema-violating, to prove the probe REPORTS a
            # rejection rather than quietly scoring it as a pass.
            return '{"steps": "not an array", oops}'
        else:
            steps = [{"action": "click", "target": {"mark": real}}]

        plan = {
            "schema_version": "1.0.0",
            "session_id": sid,
            "steps": steps,
            "confidence": 0.8,
            "needs_more_context": [],
        }
        return json.dumps(plan)


def main() -> None:
    global BEHAVIOUR
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--behaviour", default="good",
                    choices=["good", "nomark", "invent", "loose"])
    args = ap.parse_args()
    BEHAVIOUR = args.behaviour
    print(f"  mock OpenAI-compatible endpoint on http://127.0.0.1:{args.port} "
          f"(behaviour={args.behaviour})")
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
