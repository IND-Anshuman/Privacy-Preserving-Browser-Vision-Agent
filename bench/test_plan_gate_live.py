"""
The plan-vs-state gate must be LIVE, not just tested in isolation.

`check_plan_against_state` was written, unit-tested in test_server.py, and then
never called from any request path — so the suite was green while a plan naming
a mark that does not exist sailed straight through to the extension. This file
drives the real HTTP endpoint to prove the check is now reachable.

The test that matters is negative-by-construction: a plan with a BOGUS mark must
come back as `ask_user`, not as a clickable step. If this ever passes with an
executable plan, the gate is dead again.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

FAKE_PORT = 8731
API_PORT = 8741

PASS, FAIL = 0, 0
def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}" + (f"  -- {detail}" if detail else ""))


# --------------------------------------------------------------------------
# A fake OpenAI-compatible server. It returns whatever plan we ask it to, so
# each test can put a specific bad plan on the wire and watch the gate react.
# --------------------------------------------------------------------------
PLAN_TO_RETURN: dict = {"plan": {}}


class FakeVLLM(BaseHTTPRequestHandler):
    def log_message(self, *a):  # noqa: D102
        pass

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length", "0"))
        _ = self.rfile.read(n)

        # The provider sets `stream: true` and parses `data:` lines carrying
        # `choices[].delta.content`. A plain JSON body — which is what this mock
        # returned first — parses to zero tokens, so the server streams an empty
        # plan and the test sees `data: [DONE]` with no envelope.
        wants_stream = b'"stream":true' in _ or b'"stream": true' in _
        content = json.dumps(PLAN_TO_RETURN["plan"])

        if not wants_stream:
            body = json.dumps({
                "choices": [{"message": {"role": "assistant", "content": content}}]
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        # Split into a few deltas so the accumulator path is genuinely exercised.
        step = max(1, len(content) // 3)
        for i in range(0, len(content), step):
            piece = content[i:i + step]
            frame = json.dumps({"choices": [{"delta": {"content": piece}}]})
            self.wfile.write(f"data: {frame}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_GET(self):  # noqa: N802
        body = b'{"status":"ok"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve_fake() -> HTTPServer:
    srv = HTTPServer(("127.0.0.1", FAKE_PORT), FakeVLLM)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# --------------------------------------------------------------------------
def screen_state(marks: list[int], sensitive: list[int] | None = None,
                 session: str = "s-screen") -> dict:
    """A minimal schema-valid screen state carrying the given marks.

    Field-for-field against NodeModel/ScreenStateModel: every node needs `id`
    and `valueClass`, and the state carries its own `session_id`. Guessing these
    produced a 422 on the first run, which is the schema working as intended.
    """
    sensitive = sensitive or []
    children = []
    for m in marks:
        node = {
            "id": f"n{m}",
            "role": "button",
            "label": f"[BUTTON_{m}]",
            "valueClass": "sensitive" if m in sensitive else "plain",
            "mark": m,
            "children": [],
        }
        if m in sensitive:
            node["valueType"] = "password"
            node["value"] = "<redacted:password>"
        children.append(node)
    return {
        "schema_version": "1.0.0",
        "session_id": session,
        "title": "Test page",
        "url": "http://127.0.0.1:8080/test.html",
        "frame_hash": "abc123",
        "mark_count": len(marks),
        "root": {
            "id": "root",
            "role": "document",
            "label": "Test page",
            "valueClass": "plain",
            "children": children,
        },
    }


def post_step(plan: dict, marks: list[int], sensitive: list[int] | None = None,
              session: str = "sess-0001") -> dict:
    PLAN_TO_RETURN["plan"] = plan
    manifest = {
        "schema_version": "1.0.0",
        "session_id": session,
        "frame_hash": "abc123",
        "redactions": [],
        # Integrity digest, not an auth token. The server only checks presence.
        "signature": "0" * 64,
        "model_versions": {},
        "abort_reason": None,
    }
    payload = {
        "schema_version": "1.0.0",
        "session_id": session,
        "intent": "do the thing",
        "turn": 0,
        "screen_state": screen_state(marks, sensitive, session),
        "redaction_manifest": manifest,
    }
    req = urllib.request.Request(
        f"http://127.0.0.1:{API_PORT}/v1/agent/step",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()[:800]}") from e
    # The server streams `{"delta": "<json chunk>"}` envelopes. Chunks
    # concatenate into the plan — EXCEPT when the escalation gate replaces a
    # plan, which it re-streams whole as one delta AFTER the originals. So the
    # client must prefer a delta that is itself complete JSON, and this test
    # mirrors that rule (it is the same logic as extension/lib/sse.ts).
    text = ""
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            env = json.loads(payload)
        except json.JSONDecodeError:
            continue
        delta = env.get("delta") if isinstance(env, dict) else None
        if not isinstance(delta, str):
            continue
        if delta.lstrip().startswith("{"):
            try:
                json.loads(delta)
                text = delta  # a complete plan replaces what came before
                continue
            except json.JSONDecodeError:
                pass
        text += delta
    if not text.strip():
        raise RuntimeError(f"no plan deltas in response: {raw[:400]!r}")
    return json.loads(text)


def main() -> int:
    print("== plan-vs-state gate is reachable from the live endpoint ==")
    srv = serve_fake()

    os.environ.update({
        "VEIL_LLM_PROVIDER": "openai_compat",
        "VEIL_LLM_BASE_URL": f"http://127.0.0.1:{FAKE_PORT}/v1",
        "VEIL_LLM_API_KEY": "test-key-not-a-real-secret",
        "VEIL_LLM_MODEL": "fake-model",
        "VEIL_LLM_MAX_TOKENS": "2048",
        "VEIL_ALLOWED_ORIGINS": "dev",
    })

    import uvicorn
    from server.app import app

    cfg = uvicorn.Config(app, host="127.0.0.1", port=API_PORT, log_level="error")
    server = uvicorn.Server(cfg)
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{API_PORT}/health", timeout=1)
            break
        except Exception:
            time.sleep(0.1)

    try:
        base = {"schema_version": "1.0.0", "session_id": "ignored", "confidence": 0.95}

        # 1. A plan naming a mark that does not exist must be escalated.
        bad_mark = dict(base, steps=[{"action": "click", "target": {"mark": 999}}])
        res = post_step(bad_mark, marks=[1, 2], session="sess-mark")
        steps = res.get("steps", [])
        acts = [s.get("action") for s in steps]
        check("a plan naming a nonexistent mark becomes ask_user",
              acts == ["ask_user"], f"got {acts}")
        check("the reason names the bad mark",
              any("999" in (s.get("reason") or "") for s in steps),
              f"reasons={[s.get('reason') for s in steps]}")

        # 2. Filling a sensitive field must be escalated.
        fill_pw = dict(base, steps=[{"action": "fill", "target": {"mark": 3}, "value": "[EMAIL_1]"}])
        res = post_step(fill_pw, marks=[1, 2, 3], sensitive=[3], session="sess-sens")
        acts = [s.get("action") for s in res.get("steps", [])]
        check("filling a sensitive field becomes ask_user", acts == ["ask_user"], f"got {acts}")

        # 3. A VALID plan must still pass through untouched. A gate that
        #    escalates everything is as broken as one that escalates nothing.
        good = dict(base, steps=[{"action": "click", "target": {"mark": 2}}])
        res = post_step(good, marks=[1, 2], session="sess-good")
        acts = [s.get("action") for s in res.get("steps", [])]
        check("a valid plan still executes", acts == ["click"], f"got {acts}")

        # 4. An unknown mark on a page with NO marks must not crash the gate.
        no_marks = dict(base, steps=[{"action": "click", "target": {"mark": 1}}])
        try:
            res = post_step(no_marks, marks=[], session="sess-empty")
            check("a plan against a mark-less page does not 500", True)
        except Exception as exc:  # noqa: BLE001
            check("a plan against a mark-less page does not 500", False, str(exc))

        # 5. check_plan_against_state is genuinely imported by the app module.
        import server.app as appmod
        check("app.py imports check_plan_against_state",
              hasattr(appmod, "check_plan_against_state"))
        src = Path(appmod.__file__).read_text(encoding="utf-8")
        # One import line + at least one CALL. Counting the bare name is
        # misleading because the explanatory comment mentions it too.
        calls = [ln for ln in src.splitlines()
                 if "check_plan_against_state(" in ln and not ln.strip().startswith("#")]
        check("app.py CALLS check_plan_against_state (not just imports it)",
              len(calls) >= 1, f"call lines: {calls}")
    finally:
        server.should_exit = True
        time.sleep(0.4)
        srv.shutdown()

    print(f"\n{PASS}/{PASS + FAIL} passed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
