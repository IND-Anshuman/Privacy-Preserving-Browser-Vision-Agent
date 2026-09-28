"""
Build a single-document preview of the side panel, with the chrome.* API stubbed.

WHY THIS EXISTS
---------------
The panel is otherwise only reachable by loading an unpacked extension and
clicking a real page, which makes "look at the UI" a five-minute job instead of
a five-second one. A design that has never been looked at has not been designed.

An iframe was the obvious approach and it does not work: the panel module runs
inside the iframe's realm and reads the IFRAME's `chrome`, not the parent's, so
the stub has to be installed there. Same-origin for `file://` is also unreliable.
So the harness is injected into a COPY of the built panel, in the same document,
before the panel's own module runs. One realm, no iframe, no cross-origin
question.

    ./.venv/Scripts/python.exe bench/make_panel_preview.py

Writes, next to the built panel:
    panel_preview.html          ?state=empty|busy|confirm|full
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PANEL = ROOT / "extension" / ".output" / "chrome-mv3" / "sidepanel.html"
# The review build. `VEIL_OUT_DIR=.review npx wxt build` writes here, which
# matters on Windows: a process that once held a working directory inside
# `.output/chrome-mv3` keeps a handle on it and every later build fails with
# `EBUSY: rmdir` on an empty directory. Building somewhere fresh is the only
# reliable way out, and WXT 0.19 has no --outDir flag.
REVIEW_PANEL = ROOT / "extension" / ".review" / "chrome-mv3" / "sidepanel.html"

STATES_JS = r"""
const __params = new URLSearchParams(location.search)
const __want = __params.get('state') || 'empty'
const __listeners = []
window.__sent = []

window.chrome = {
  runtime: {
    sendMessage: async (m) => { window.__sent.push(m); return { ok: true } },
    onMessage: {
      addListener: (f) => __listeners.push(f),
      removeListener: (f) => { const i = __listeners.indexOf(f); if (i >= 0) __listeners.splice(i, 1) },
    },
  },
}
const emit = (m) => __listeners.forEach((f) => f(m))

const __red = (n, cls) => Array.from({ length: n }, (_, i) => ({
  id: 'r' + i, cls, placeholder: { token: `[${cls}_A3_${i}a2b3c4d]` },
  box: { x: 10, y: 20 + i * 8, w: 300, h: 22 },
  method: 'L1', score: 0.97, source: 'regex', pixelDerived: false,
}))
const __manifest = (list) => ({
  schema_version: '1.0.0', session_id: 'sess-abc12345',
  redactions: list.flatMap(([n, c]) => __red(n, c)),
  frame_hash: 'abc123def456', signature: 'sig', model_versions: {},
})

const __STATES = {
  empty: [],

  busy: [
    { kind: 'panel:stage', runId: 'run-1', stage: 'snapshot', ms: 18 },
    { kind: 'panel:stage', runId: 'run-1', stage: 'capture+redact', ms: 31 },
  ],

  // The state that matters: the agent is blocked and waiting for a human.
  confirm: [
    { kind: 'panel:stage', runId: 'run-2', stage: 'snapshot', ms: 21 },
    { kind: 'panel:stage', runId: 'run-2', stage: 'capture+redact', ms: 29 },
    { kind: 'redact:ready', runId: 'run-2', bytes: 41230, tiles: [],
      verdict: { ok: true, covered: 12, uncovered: 0 },
      manifest: __manifest([[2,'AADHAAR'],[1,'PAN'],[1,'PERSON'],[1,'CREDIT_CARD'],[1,'OPAQUE_REGION']]) },
    { kind: 'panel:stage', runId: 'run-2', stage: 'server', ms: 690 },
    { kind: 'panel:plan', runId: 'run-2', plan: { schema_version: '1.0.0',
      session_id: 'sess-abc12345', confidence: 0.62, needs_more_context: [], steps: [
        { action: 'fill', target: { mark: 4 }, value: '[PERSON_A3_1a2b3c4d]' },
        { action: 'click', target: { mark: 9 } },
        { action: 'click', target: { mark: 12 },
          reason: 'This submits the application to the site.' } ] } },
    { kind: 'execute:confirm_required', runId: 'run-2', actionIndex: 2,
      label: 'This submits the application to the site. That is not reversible from here.' },
  ],

  full: [
    { kind: 'panel:stage', runId: 'run-3', stage: 'snapshot', ms: 17 },
    { kind: 'panel:stage', runId: 'run-3', stage: 'capture+redact', ms: 28 },
    { kind: 'redact:ready', runId: 'run-3', bytes: 38900, tiles: [],
      verdict: { ok: true, covered: 9, uncovered: 0 },
      manifest: __manifest([[3,'AADHAAR'],[2,'PAN'],[1,'PERSON'],[1,'EMAIL'],[1,'PHONE']]) },
    { kind: 'panel:stage', runId: 'run-3', stage: 'server', ms: 640 },
    { kind: 'panel:stage', runId: 'run-3', stage: 'execute', ms: 24 },
    { kind: 'panel:plan', runId: 'run-3', plan: { schema_version: '1.0.0',
      session_id: 'sess-abc12345', confidence: 0.88, needs_more_context: [], steps: [
        { action: 'fill', target: { mark: 4 } },
        { action: 'fill', target: { mark: 6 } },
        { action: 'click', target: { mark: 9 } } ] } },
    { kind: 'execute:done', runId: 'run-3', actionIndex: 0, ok: true, status: 'filled', ms: 12 },
    { kind: 'execute:done', runId: 'run-3', actionIndex: 1, ok: true, status: 'filled', ms: 9 },
    { kind: 'execute:done', runId: 'run-3', actionIndex: 2, ok: true, status: 'clicked', ms: 6 },
    { kind: 'panel:answer', runId: 'run-3', tier: 'T1', text:
      'Filled the two empty fields and opened the review page. I stopped before the final submit — that one is yours to press.' },
  ],
}

window.addEventListener('load', () => {
  const ta = document.getElementById('intent')
  const msgs = __STATES[__want] ?? __STATES.empty

  if (__want !== 'empty' && ta) {
    ta.value = 'Fill the fields you can see and stop before submitting'
    document.getElementById('run')?.click()
  }
  // Stagger so the panel's own render path is exercised turn by turn, which is
  // the only way a dropped message shows up.
  msgs.forEach((m, i) => setTimeout(() => emit(m), 60 + i * 40))
})
"""


def main() -> int:
    # Prefer the review build; fall back to the normal one so the script still
    # works for someone who has not hit the Windows lock.
    panel = REVIEW_PANEL if REVIEW_PANEL.exists() else PANEL
    if not panel.exists():
        print("  no built panel found. Run one of:", file=sys.stderr)
        print("    cd extension && VEIL_OUT_DIR=.review npx wxt build", file=sys.stderr)
        print("    cd extension && npx wxt build", file=sys.stderr)
        return 2

    html = panel.read_text(encoding="utf-8")

    # The built panel references its bundle as `/chunks/...`, an ABSOLUTE path
    # that only resolves when served from a domain root. Opening the file
    # directly with file:// therefore 404s the module and the panel never boots —
    # which looks exactly like "the stub is not firing" and cost a debugging
    # detour. Rewritten to a relative path so the preview works from disk.
    def relativise(m: re.Match[str]) -> str:
        tag = m.group(0)
        return tag.replace('src="/', 'src="./').replace("href=\"/", "href=\"./")

    html = re.sub(r'<script[^>]*\ssrc="/[^"]*"[^>]*>', relativise, html)
    html = re.sub(r'<link[^>]*\shref="/[^"]*"[^>]*>', relativise, html)

    # The stub must run BEFORE the panel's module, so it is injected into <head>
    # rather than appended at the end. A stub installed afterwards is a stub that
    # does not exist by the time the panel reads `chrome`.
    stub = f"<script>{STATES_JS}</script>\n"
    if "</head>" not in html:
        print("  built panel has no </head> to inject into", file=sys.stderr)
        return 2
    html = html.replace("</head>", f"  {stub}</head>", 1)

    out = panel.parent / "panel_preview.html"
    out.write_text(html, encoding="utf-8")
    print(f"  wrote {out}")
    print("  open it with ?state=empty | busy | confirm | full")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
