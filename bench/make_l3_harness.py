"""
Build a self-contained HTML page that measures the L3 text detector in a REAL
browser, because Node has no OffscreenCanvas and a jsdom canvas draws nothing.

The page inlines the actual `runL3Text` source extracted from models.ts, so this
measures the shipped code rather than a reimplementation of it. A detector
measured through a port is a measurement of the port.

    ./.venv/Scripts/python.exe bench/make_l3_harness.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "extension" / "entrypoints" / "offscreen" / "models.ts"
CORPUS = ROOT / "bench" / "corpus" / "synthetic"
OUT = ROOT / "bench" / "l3_canvas.html"

TYPE_DECL = """
type PiiClass = string
type PixelBox = { box: { x: number; y: number; w: number; h: number }; score: number; cls: PiiClass }
"""


def extract_run_l3_text() -> str:
    src = MODELS.read_text(encoding="utf-8")
    start = src.find("export async function runL3Text")
    if start < 0:
        raise SystemExit("runL3Text not found in models.ts")
    # The function is the last top-level `export async function` in the file and
    # ends at the first column-0 closing brace after it.
    end = src.find("\n}\n", start)
    if end < 0:
        raise SystemExit("could not find the end of runL3Text")
    body = src[start : end + 3]
    body = body.replace("export async function", "async function")
    return body


def strip_types(src: str) -> str:
    """Remove TypeScript-only syntax from the extracted function.

    The harness is a plain <script>, so `type PiiClass = string`, parameter and
    return annotations, and `as PiiClass` casts must all go. Doing this by hand
    would mean maintaining a second copy of the detector, and a measurement of a
    copy is a measurement of the copy — so the transform is narrow and
    mechanical, and main() asserts the result still contains the function.
    """
    # `interface X { ... }` — non-greedy, and only up to the FIRST closing brace
    # at column 0. A greedy `.*?^\}$` with DOTALL once matched from the
    # `interface PixelBox` line all the way to the end of the file and deleted
    # the detector along with it.
    src = re.sub(r"^interface\s+\w+\s*\{[^{}]*\}", "", src, flags=re.M)
    src = re.sub(r"^type\s+\w+\s*=\s*.*$", "", src, flags=re.M)
    # The return type first, then parameter annotations. Order matters: the
    # return type is `): Promise<{ boxes: PixelBox[]; ... }> {`, and a
    # parameter-annotation pass running first would rewrite `boxes: PixelBox[]`
    # inside it and leave `PixelBox` stranded in the output.
    src = re.sub(r"\)\s*:\s*Promise<.*?>\s*\{", ") {", src, flags=re.S)
    # Variable annotations: `const x: T = ...` / `let x: T`. The parameter pass
    # below only looks for a following comma or paren, so a declaration
    # followed by ` = ` kept its type — that is where a stray `: PixelBox[]`
    # was surviving.
    src = re.sub(r"\b(const|let|var)\s+([A-Za-z_]\w*)\s*:\s*[^=\n]+(?=\s*=)", r"\1 \2", src)
    # Parameter annotations, applied ONLY inside a function signature.
    # Running this across the whole body ate `performance.now()` inside object
    # literals — `ms: performance.now() - t0` matched as a `name: Type`
    # annotation and became `ms) - t0`. A signature is the only place a
    # parameter annotation can legally appear.
    def strip_signature(m: re.Match[str]) -> str:
        sig = re.sub(r"(\b[A-Za-z_]\w*)\s*:\s*[^,)]*?(?=\s*[,)])", r"\1", m.group(2))
        # A trailing comma in a parameter list is a TypeScript nicety that older
        # parsers reject, and it is what produced "Unexpected token 'if'" on
        # `async function runL3Text(source,) {`.
        sig = re.sub(r",\s*$", "", sig)
        return m.group(1) + sig + m.group(3)

    src = re.sub(r"(\bfunction\s+\w+\s*\()([^)]*)(\))", strip_signature, src)
    src = re.sub(r"(\bcatch\s*\()([^)]*)(\))", strip_signature, src)
    src = re.sub(r"\bas\s+[A-Za-z_]\w*", "", src)
    # Non-null assertions. `x!`, `x.y!` and `arr[i]!` are the same operator; the
    # earlier `!\.` rule only handled the second form. The operator is `!` when
    # it follows a value and is NOT followed by `=`, so `!==` and `!=` are left
    # alone. The replacement keeps the following character — an earlier version
    # dropped it and turned `img.data[i]! + 0.587` into `img.data[i]+ 0.587`,
    # then ate the `;` and merged two statements.
    src = re.sub(r"([\w\)\]])!(?![=])(\s*)(?=[^\s])", r"\1\2", src)
    return src


def _parses_as_js(src: str) -> bool:
    """True when `src` is syntactically valid JavaScript.

    Uses node if it is on PATH, because that is the same parser class the
    browser runs. Returns True (do not block) if node is unavailable — a
    missing tool must not stop the harness from being generated.
    """
    import shutil
    import subprocess
    import tempfile

    node = shutil.which("node")
    if not node:
        return True
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
        fh.write(src)
        path = fh.name
    try:
        proc = subprocess.run(
            [node, "--check", path], capture_output=True, text=True, timeout=30
        )
        if proc.returncode == 0:
            return True
        print(proc.stderr.strip()[:600], file=sys.stderr)
        return False
    finally:
        Path(path).unlink(missing_ok=True)


def main() -> None:
    raw = extract_run_l3_text()
    detector = strip_types(raw)
    if "async function runL3Text" not in detector:
        raise SystemExit("type-stripping destroyed the function")
    # A length guard, because the one silent failure here was a regex that
    # deleted the whole detector and produced a page that merely said
    # "running…" forever. Losing 80% of the function must be a build error.
    if len(detector) < len(raw) * 0.7:
        raise SystemExit(
            f"strip_types removed too much: {len(raw)} -> {len(detector)} chars"
        )
    # The page is a plain <script>, so surviving TypeScript syntax is a silent
    # whole-page parse failure: the harness renders "running…" forever and
    # reports nothing. Three of those came from here, so it is worth checking —
    # but the check has to avoid flagging valid JS object properties, which look
    # identical to annotations. The discriminator: a real annotation names a
    # TYPE (uppercase or known), while an object property is followed by a value.
    stripped = strip_types(TYPE_DECL + detector)
    annotations = re.compile(
        r"(?:^|[(,{;\s])"
        r"([A-Za-z_]\w*)\s*:\s*"
        r"([A-Z]\w*(?:<[^>]*>)?(?:\[\])?|string|number|boolean|void|any|unknown|never)"
        r"\s*[,)=;\n]"
    )
    for m in annotations.finditer(stripped):
        line_start = stripped.rfind("\n", 0, m.start()) + 1
        line_end = stripped.find("\n", m.end())
        line = stripped[line_start : line_end if line_end > 0 else len(stripped)]
        if "//" in line[: line.find(m.group(0))]:
            continue  # a comment
        raise SystemExit(
            f"TypeScript annotation survived: {m.group(0)!r}\n  line: {line.strip()!r}"
        )
    for token in ("interface ", "type PiiClass", " as PiiClass", ": Promise<", "]!", ")!"):
        at = stripped.find(token)
        if at >= 0:
            raise SystemExit(
                f"TypeScript syntax survived into the harness: {token!r}\n"
                f"  at {at}: {stripped[max(0, at - 160):at + 120]!r}"
            )
    # A trailing comma in a parameter list is a TS nicety the page's parser
    # rejects, and it is invisible to every check above. Rather than discover
    # it in the browser — where the only symptom is a page that says
    # "running…" forever — verify the detector actually parses as JavaScript.
    if not _parses_as_js(detector):
        raise SystemExit(
            "the extracted detector is not valid JavaScript after stripping; "
            "it would render a blank harness in the browser"
        )

    cases: list[dict[str, object]] = []
    for meta_path in sorted(CORPUS.glob("form_*.json")):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        pixels = [i for i in meta["instances"] if i.get("channel") == "pixels"]
        if not pixels:
            continue
        # FACE is the face detector's job. Scoring the text pass on it would
        # measure the wrong model.
        text_pii = [i for i in pixels if i["cls"] != "FACE"]
        if not text_pii:
            continue
        cases.append({"id": meta["id"], "pii": [{"cls": i["cls"], "value": i["value"]} for i in text_pii]})

    page = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>L3 canvas coverage</title>
<style>
 body {{ font: 14px ui-monospace, monospace; background:#0b1120; color:#e2e8f0; padding:24px }}
 h1 {{ font-size:16px; letter-spacing:.04em; text-transform:uppercase; color:#94a3b8 }}
 pre {{ background:#111827; border:1px solid #1f2937; padding:16px; border-radius:8px; overflow:auto }}
 .ok {{ color:#34d399 }} .bad {{ color:#f87171 }} .dim {{ color:#64748b }}
 canvas {{ border:1px dashed #334155; margin:4px; }}
</style></head>
<body>
<h1>L3 canvas coverage &mdash; measured in this browser</h1>
<pre id="out">running&hellip;</pre>
<div id="canvases"></div>
<script>
{strip_types(TYPE_DECL + detector)}

/* Mirrors bench/measure_l3_canvas.ts, minus the port. */
const CASES = {json.dumps(cases)};
const W = 640, H = 220, LINE = 40, TOP = 40, LEFT = 20;

function covers(boxes, x, y) {{
  return boxes.some(b => x >= b.box.x && x <= b.box.x + b.box.w && y >= b.box.y && y <= b.box.y + b.box.h);
}}

async function run() {{
  const out = document.getElementById('out');
  const host = document.getElementById('canvases');
  let checked = 0, covered = 0, boxes = 0, ms = 0, n = 0;
  const missed = [];

  for (const c of CASES) {{
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000000'; ctx.font = '16px monospace';
    c.pii.forEach((inst, i) => ctx.fillText(inst.value, LEFT, TOP + i * LINE));

    const r = await runL3Text(canvas);
    boxes += r.boxes.length; ms += r.ms; n++;
    if (!r.available) continue;

    for (let i = 0; i < c.pii.length; i++) {{
      checked++;
      if (covers(r.boxes, LEFT, TOP + i * LINE)) covered++;
      else if (missed.length < 8) missed.push(c.pii[i].cls + ' ' + JSON.stringify(c.pii[i].value.slice(0, 28)));
    }}
    // Draw the regions the detector found, so a human can see whether it is
    // finding the text or something else entirely.
    ctx.strokeStyle = 'rgba(220,38,38,.85)'; ctx.lineWidth = 2;
    for (const b of r.boxes) ctx.strokeRect(b.box.x, b.box.y, b.box.w, b.box.h);
  }}

  const pct = d => d === 0 ? 'n/a' : ((d / 100 * 100).toFixed(1) + '%');
  const rate = (a, b) => b === 0 ? 'n/a' : (a / b * 100).toFixed(1) + '%';
  out.textContent = [
    'L3 CANVAS COVERAGE (real canvas, real rendered text)',
    '='.repeat(66),
    `  user agent        : ${{ navigator.userAgent.slice(0, 60) }}`,
    `  canvases measured : ${{n}}`,
    `  PII lines drawn   : ${{checked}}`,
    `  covered by region : ${{covered}}  (${{rate(covered, checked)}})`,
    `  regions found     : ${{boxes}}  (avg ${{(boxes / Math.max(1, n)).toFixed(1)}}/canvas)`,
    `  detector cost     : ${{(ms / Math.max(1, n)).toFixed(1)}} ms/canvas`,
    missed.length ? '  missed:\\n' + missed.map(m => '    ' + m).join('\\n') : '  missed            : (none)',
    '='.repeat(66),
    'Red boxes are the detected regions. This is the DETECTOR only; end-to-end',
    'canvas safety also rests on the OPAQUE_REGION fail-closed rule.',
  ].join('\\n');

  window.__RESULT__ = {{ checked, covered, boxes, ms: ms / Math.max(1, n), canvases: n, missed }};
  document.title = 'done';
}}

run().catch(e => {{
  document.getElementById('out').textContent = 'FAILED: ' + e.message + '\\n' + e.stack;
  window.__ERROR__ = String(e && e.stack || e);
  document.title = 'done';
}});
</script>
</body></html>
"""
    OUT.write_text(page, encoding="utf-8")
    print(f"wrote {OUT}  ({len(cases)} canvases, {len(detector)} chars of detector source inlined)")


if __name__ == "__main__":
    main()
